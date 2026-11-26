// Package dbclient：内置数据库连接与浏览引擎（SQLite 本地库 / MySQL 远程连接）。
//
// 分层约定与 internal/sqlview 一致：纯引擎包，不 import main、不碰 App；
// 外部动作（应用数据目录、诊断日志）经宿主注入钩子，根壳 dbclient_app.go 只转发。
//
// 安全模型（docs/unfinished-plans/db-connection-tools.md §6，P0 起即生效）：
//   - 默认只读：RO 会话在查询路径逐条分类拒绝一切写/DDL（guard.go），不依赖驱动只读标志；
//     SQLite 另加 mode=ro 硬兜底，MySQL 另加 transaction_read_only=1（连接池限 1 连接）。
//   - 写入是显式授权：连接级 AllowEdit（SQLite 为打开时的开关）+ 危险语句（DROP/TRUNCATE/
//     ATTACH/CALL 等）与缺 WHERE 的 UPDATE/DELETE 需要前端二次确认后才执行（两阶段协议）。
//   - 行定位只认主键：无主键表一律只读（不学 DBeaver「所有列当键」）。
//   - 凭据经 internal/dpapi 加密单独存放，配置与凭据分离；写留痕由前端经 activity 攒批记录，
//     不含参数值与密码。
package dbclient

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"datalens/internal/sqlview"
)

const (
	queryTimeout        = 20 * time.Second // 与 sqlview 的 sqlQueryTimeout 对齐
	applyTimeout        = 60 * time.Second // 批量提交（单事务）允许比单条查询宽
	rowDefault          = 500              // 默认行数上限（方案 §5.1）
	rowMax              = 5000             // 行数硬上限
	maxSessions         = 8                // 会话数上限
	idleCloseAfter      = 15 * time.Minute // 空闲断连
	idleSweepEvery      = 5 * time.Minute  // 回收扫描周期
	connectionsFileName = "db-connections.json"
	credentialsFileName = "db-credentials.json"
	configLockFile      = ".db-connections.lock"
	kindSQLite          = "sqlite"
	kindMySQL           = "mysql"
	kindRedis           = "redis"
)

// 宿主注入钩子（根壳 dbclient_app.go 的 init 里赋值；测试里换成临时目录）。
var (
	// AppDataDir 应用数据根目录（internal/appdata.Root()）；为空时连接配置不可用。
	AppDataDir func() string
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
)

func logWarn(format string, args ...any) {
	if Logf != nil {
		Logf("WARN", "dbclient: "+format, args...)
	}
}

// Capabilities 驱动能力位（前端据此渲染可用的操作）。
type Capabilities struct {
	ReadOnly    bool `json:"readOnly"`    // 驱动是否天然只读（当前无此类驱动）
	Transaction bool `json:"transaction"` // 支持事务——指批量编辑的单事务提交（ApplyChanges）；控制台不支持手写 BEGIN/COMMIT（见 guard.go checkBatch）
	Editable    bool `json:"editable"`    // 支持单元格编辑
	DDL         bool `json:"ddl"`         // 允许结构变更：SQLite 已开放（仅 editable 会话，DROP 类走两阶段确认）；MySQL 恒 false
}

// ConnectionConfig 连接配置（非敏感字段，落 db-connections.json）。
// 密码经 dpapi 加密另存 db-credentials.json；SQLite 是临时会话不落连接表。
// Redis 的 Database 字段复用为数据库编号（"0"–"15"）、User 复用为 ACL 用户名（可空）。
type ConnectionConfig struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"` // "mysql" | "redis"
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Database  string `json:"database,omitempty"`
	User      string `json:"user,omitempty"`
	AllowEdit bool   `json:"allowEdit"`
	UpdatedAt int64  `json:"updatedAt"`
}

// SessionInfo 会话摘要（返回给前端）。
type SessionInfo struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Server    string `json:"server,omitempty"`
	Database  string `json:"database,omitempty"`
	Editable  bool   `json:"editable"`
	Immutable bool   `json:"immutable,omitempty"` // SQLite：mode=ro 失败后以 immutable 兜底打开
}

// DBObject 元数据 L1：一张表/视图的名字与类型（点开才拉 L2 详情，方案 §3.1）。
type DBObject struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"` // "table" | "view"
	RowEstimate int64  `json:"rowEstimate,omitempty"`
	Comment     string `json:"comment,omitempty"` // 表注释（MySQL 专有；SQLite 恒空）
}

// ColumnMeta 元数据 L2：一列的定义。
type ColumnMeta struct {
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	NotNull bool    `json:"notNull"`
	Default *string `json:"default,omitempty"`
	PK      bool    `json:"pk"`
}

// IndexMeta 一个索引。
type IndexMeta struct {
	Name    string   `json:"name"`
	Unique  bool     `json:"unique"`
	Columns []string `json:"columns"`
}

// ForeignKeyMeta 一个外键约束（SQLite PRAGMA foreign_key_list；为后续结构编辑铺路）。
type ForeignKeyMeta struct {
	Columns    []string `json:"columns"`
	RefTable   string   `json:"refTable"`
	RefColumns []string `json:"refColumns,omitempty"`
	OnUpdate   string   `json:"onUpdate,omitempty"`
	OnDelete   string   `json:"onDelete,omitempty"`
}

// DBTableMeta 元数据 L2：整表定义。PK 为空时该表不可编辑（无主键一律只读）。
type DBTableMeta struct {
	Table        string           `json:"table"`
	Database     string           `json:"database,omitempty"`
	Kind         string           `json:"kind"`
	Columns      []ColumnMeta     `json:"columns"`
	PK           []string         `json:"pk"`
	Indexes      []IndexMeta      `json:"indexes"`
	ForeignKeys  []ForeignKeyMeta `json:"foreignKeys,omitempty"`
	RowEstimate  int64            `json:"rowEstimate,omitempty"`
	TableComment string           `json:"tableComment,omitempty"` // 表注释（MySQL 专有）
	Editable     bool             `json:"editable"`
}

// OrderCol 多列排序（结构化：列名在 Go 侧过元数据白名单后拼 ORDER BY，不拼原始 SQL 片段）。
type OrderCol struct {
	Column string `json:"column"`
	Desc   bool   `json:"desc"`
}

// FilterCond 表浏览的结构化筛选（列名经元数据校验、值走占位符参数，不拼进 SQL）。
type FilterCond struct {
	Column string `json:"column"`
	Op     string `json:"op"` // eq|ne|lt|le|gt|ge|contains|null|notNull
	Value  string `json:"value,omitempty"`
}

// BrowseRequest 表浏览请求（排序/筛选/分页全部下推，方案 §5.1 的「排序筛选下推」决策）。
type BrowseRequest struct {
	Database   string       `json:"database,omitempty"`
	Table      string       `json:"table"`
	SortColumn string       `json:"sortColumn,omitempty"` // 单列排序（列头点击；与 OrderCols 二选一，OrderCols 优先）
	SortDesc   bool         `json:"sortDesc"`
	OrderCols  []OrderCol   `json:"orderCols,omitempty"` // 多列排序（ORDER BY 面板）
	Filters    []FilterCond `json:"filters,omitempty"`
	Offset     int          `json:"offset"`
	Limit      int          `json:"limit"`
	QueryID    string       `json:"queryId,omitempty"` // 本次浏览的取消句柄；与 DBCancel 对应
}

// QueryOutcome 控制台查询结果。Status=confirm 表示 guard 要求二次确认（Confirm 给出原因），
// 前端弹确认层后带 confirm=true 重发；这是「危险语句两阶段执行」协议的后半段。
// StatementResult 控制台逐条语句的执行结果（Results 与 Statements 同序）。
type StatementResult struct {
	SQL    string            `json:"sql"`
	Result sqlview.SQLResult `json:"result"`
	Wrote  bool              `json:"wrote,omitempty"`
}

type QueryOutcome struct {
	Status     string            `json:"status"`            // "ok" | "confirm"
	Confirm    string            `json:"confirm,omitempty"` // "danger" | "missingWhere"
	Message    string            `json:"message,omitempty"`
	Result     sqlview.SQLResult `json:"result,omitempty"` // 兼容字段 = 最后一条语句的结果
	Results    []StatementResult `json:"results,omitempty"`
	Statements int               `json:"statements,omitempty"`
	Writes     int               `json:"writes,omitempty"` // 已执行的写语句数（前端据此记操作留痕）
}

// CellUpdate 单元格修改：Keys 是主键定位（列名→原值）；OldValue/NewValue 为 nil 表示 SQL NULL。
type CellUpdate struct {
	Keys     map[string]string `json:"keys"`
	Column   string            `json:"column"`
	OldValue *string           `json:"oldValue"`
	NewValue *string           `json:"newValue"`
}

// RowDelete 行删除（主键定位）。
type RowDelete struct {
	Keys map[string]string `json:"keys"`
}

// RowInsert 新行（列名→值，nil 表示 SQL NULL；未提供的列交给表默认值）。
type RowInsert struct {
	Values map[string]*string `json:"values"`
}

// TableChanges 一批待提交修改（同一张表，包在单个事务里提交，方案 §5.3）。
type TableChanges struct {
	Database string       `json:"database,omitempty"`
	Table    string       `json:"table"`
	Updates  []CellUpdate `json:"updates,omitempty"`
	Deletes  []RowDelete  `json:"deletes,omitempty"`
	Inserts  []RowInsert  `json:"inserts,omitempty"`
}

// ChangeStatement 预览里的一条语句。SQL 已内联展示值、仅供人看；实际执行走参数化占位符。
type ChangeStatement struct {
	Kind string `json:"kind"` // update|delete|insert
	SQL  string `json:"sql"`
}

// ApplyResult 提交结果；任一语句行数不符预期时整体回滚并报冲突错误。
type ApplyResult struct {
	Updates   int   `json:"updates"`
	Deletes   int   `json:"deletes"`
	Inserts   int   `json:"inserts"`
	ElapsedMs int64 `json:"elapsedMs"`
}

var (
	// ErrSessionNotFound 会话不存在（被断开/空闲回收）。
	ErrSessionNotFound = errors.New("连接会话不存在，可能已断开或空闲超时，请重新连接")
	// ErrReadOnlySession 只读会话拒绝写操作。
	ErrReadOnlySession = errors.New("只读连接拒绝写操作；如需编辑请在打开连接时显式开启「允许编辑」")
)

// ---------- 对外入口（根壳 dbclient_app.go 转发到这里） ----------

// OpenSQLite 打开本地 SQLite 库文件（只读会话除非显式 allowEdit）。
func OpenSQLite(path string, allowEdit bool) (SessionInfo, error) {
	return openSession(openSpec{Kind: kindSQLite, Path: path, AllowEdit: allowEdit})
}

// ListDatabases 库清单（SQLite 返回 main 占位）。
func ListDatabases(id string) ([]string, error) {
	s, err := getSession(id)
	if err != nil {
		return nil, err
	}
	return listDatabasesMeta(s)
}

// ListObjects 元数据 L1：库内表/视图清单。
func ListObjects(id, database string) ([]DBObject, error) {
	s, err := getSession(id)
	if err != nil {
		return nil, err
	}
	return listObjectsMeta(s, database)
}

// Describe 元数据 L2：表定义（noCache=true 供写后刷新）。
func Describe(id, database, table string, noCache bool) (*DBTableMeta, error) {
	s, err := getSession(id)
	if err != nil {
		return nil, err
	}
	return describeMeta(s, database, table, noCache)
}

// ServerObjectGroup 服务器对象分组（MySQL 专属元数据：排序规则/用户/系统虚拟视图）。
type ServerObjectGroup struct {
	ID    string   `json:"id"`    // collations | users | sysviews
	Label string   `json:"label"` // 展示名
	Items []string `json:"items"`
	Error string   `json:"error,omitempty"` // 该组查询失败原因（权限不足等），前端隐藏整组
}

// ServerObjects 服务器对象清单；nil 表示该驱动无此能力（SQLite/插件）。
type ServerObjects struct {
	Groups []ServerObjectGroup `json:"groups"`
}

// ListServerObjects 服务器对象（MySQL 专属）；其他驱动返回 nil。每组独立查询独立容错。
func ListServerObjects(id string) (*ServerObjects, error) {
	s, err := getSession(id)
	if err != nil {
		return nil, err
	}
	if s.kind != kindMySQL {
		return nil, nil
	}
	return mysqlListServerObjects(s), nil
}

// clampRowLimit 行数上限收口（与 sqlview 同口径）。
func clampRowLimit(limit int) int {
	if limit <= 0 {
		return rowDefault
	}
	if limit > rowMax {
		return rowMax
	}
	return limit
}

// quoteIdent 标识符按方言加引号：SQLite 用双引号、MySQL 用反引号。
func quoteIdent(kind, name string) string {
	switch kind {
	case kindMySQL:
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	default:
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
}

// quoteTableRef 限定表名引用（MySQL 带库名限定，SQLite 只有单文件）。
func quoteTableRef(kind, database, table string) string {
	t := quoteIdent(kind, table)
	if kind == kindMySQL && database != "" {
		return quoteIdent(kind, database) + "." + t
	}
	return t
}

// formatCell 查询结果单元格转字符串（与 sqlview.sqlCellString 同口径）。
// 返回值第二个 bool 表示是否 SQL NULL。
func formatCell(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "", true
	case []byte:
		return string(t), false
	case bool:
		if t {
			return "1", false
		}
		return "0", false
	case time.Time:
		return t.Format(time.RFC3339), false
	case string:
		return t, false
	default:
		return fmt.Sprint(v), false
	}
}
