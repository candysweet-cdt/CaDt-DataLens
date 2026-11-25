package dbclient

// service.go：Wails 绑定承载类型（原根 dbclient_app.go）。App 匿名嵌入 *Service 后，
// 这里的导出方法自动进 *App 方法集，前端 FQN 仍是 main.App.DB<x>（v3 无生成绑定，
// 前端经 Call.ByName 动态解析；dev/mock-backend.js 必须补同名 mock）。
//
// 纪律：只放要暴露给前端的方法；其余能力保持包级函数。

import (
	"fmt"
	"os"

	"datalens/internal/sqlview"
)

// Service 是数据库连接与浏览的绑定承载类型。
type Service struct{}

func (s *Service) DBOpen(path string, allowEdit bool) (SessionInfo, error) {
	return OpenSQLite(path, allowEdit)
}

// DBCreateSQLite 新建空 SQLite 库文件（已存在即报错，不覆盖；前端「新建 SQLite 数据库…」入口）。
func (s *Service) DBCreateSQLite(path string) error {
	return CreateSQLite(path)
}

// DBReadImportFile 导入数据（CSV/JSONL）的文本读取：UTF-8，上限 20 MB 防大文件卡顿。
func (s *Service) DBReadImportFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > 20*1024*1024 {
		return "", fmt.Errorf("导入文件超过 20 MB 上限，请先拆分再导入")
	}
	return string(data), nil
}

func (s *Service) DBConnect(connectionID string) (SessionInfo, error) {
	return Connect(connectionID)
}

// ---------- Redis 键空间（redis_session.go；方案 §5.4） ----------

// DBRedisScan SCAN 一批键（cursor 续扫；MATCH/TYPE/COUNT 可选），批量带出类型/TTL/长度。
func (s *Service) DBRedisScan(id, database, pattern string, cursor uint64, count int, typeFilter string) (RedisScanResult, error) {
	return RedisScanKeys(id, database, pattern, cursor, count, typeFilter)
}

// DBRedisFetchValue 读一个键的值（按类型统一转行集；string 走 Text/HexText）。
func (s *Service) DBRedisFetchValue(id, database, key string) (RedisValue, error) {
	return RedisFetchValue(id, database, key)
}

// DBRedisApply 结构化编辑提交（editable 会话；前端展示等价命令预览后调用）。
func (s *Service) DBRedisApply(id string, ops []RedisOp) (sqlview.SQLResult, error) {
	return RedisApply(id, ops)
}

// DBRedisDeleteByPrefix 前缀批量删除（SCAN + UNLINK；前端确认后调用；空前缀拒绝）。
func (s *Service) DBRedisDeleteByPrefix(id, database, prefix string) (RedisPrefixDelete, error) {
	return RedisDeleteByPrefix(id, database, prefix)
}

func (s *Service) DBListDatabases(id string) ([]string, error) {
	return ListDatabases(id)
}

func (s *Service) DBListObjects(id, database string) ([]DBObject, error) {
	return ListObjects(id, database)
}

func (s *Service) DBDescribe(id, database, table string, noCache bool) (*DBTableMeta, error) {
	return Describe(id, database, table, noCache)
}

// DBListServerObjects 服务器对象分组（MySQL 专属：排序规则/用户/系统虚拟视图；其他 kind 返回 null）。
func (s *Service) DBListServerObjects(id string) (*ServerObjects, error) {
	return ListServerObjects(id)
}

func (s *Service) DBBrowse(id string, req BrowseRequest) (sqlview.SQLResult, error) {
	return Browse(id, req)
}

// DBQuery 控制台查询：confirmed=false 时危险/缺 WHERE 语句返回 Status=confirm（两阶段确认）。
func (s *Service) DBQuery(id, queryID, query string, confirmed bool, limit int) (QueryOutcome, error) {
	return Query(id, queryID, query, confirmed, limit)
}

func (s *Service) DBCancel(id, queryID string) error {
	return Cancel(id, queryID)
}

func (s *Service) DBClose(id string) error {
	return CloseSession(id)
}

func (s *Service) DBListConnections() ([]ConnectionConfig, error) {
	return ListConnections()
}

func (s *Service) DBSaveConnection(cfg ConnectionConfig, password string) (ConnectionConfig, error) {
	return SaveConnection(cfg, password)
}

func (s *Service) DBDeleteConnection(id string) error {
	return DeleteConnection(id)
}

func (s *Service) DBTestConnection(cfg ConnectionConfig, password string) (string, error) {
	return TestConnection(cfg, password)
}

// DBImportConnections 从连接配置文件（db-connections.json 同构）导入 MySQL/MariaDB/Redis 连接。
// 不做 DNS 解析、不导凭据（dpapi 绑定本机）、新条目一律只读——细节见 importconfig.go。
func (s *Service) DBImportConnections(path string) (ImportResult, error) {
	return ImportConnectionsFile(path)
}

func (s *Service) DBPreviewChanges(id string, changes TableChanges) ([]ChangeStatement, error) {
	return PreviewChanges(id, changes)
}

func (s *Service) DBApplyChanges(id string, changes TableChanges) (ApplyResult, error) {
	return ApplyChanges(id, changes)
}

// DBCredentialPut / DBCredentialGet：插件数据库驱动的通用凭据存取
// （键任意字符串，约定 dbplug:<条目id>:<字段键>；dpapi 加密，与连接凭据同一张表）。
func (s *Service) DBCredentialPut(key, plain string) error {
	return CredentialPut(key, plain)
}

func (s *Service) DBCredentialGet(key string) (string, error) {
	return CredentialGet(key)
}
