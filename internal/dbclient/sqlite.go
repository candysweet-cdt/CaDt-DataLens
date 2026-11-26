package dbclient

// sqlite.go：SQLite 驱动——复用已在库的 modernc.org/sqlite（纯 Go），零新依赖。
//
// 只读会话用 mode=ro 硬兜底（guard 之外的第二道）；WAL 库的 -wal/-shm 无读权限时 mode=ro
// 会失败——按方案 §5.1 以 immutable=1 兜底重试一次，SessionInfo.Immutable 标记后前端提示
// 「数据可能不反映正在进行的写入」，不做静默降级。允许编辑的会话以读写模式打开，
// 写入能力另由 guard 分类 + 会话级 editable 控制。

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type sqliteDriver struct{}

func (sqliteDriver) Kind() string { return kindSQLite }

func (sqliteDriver) Capabilities() Capabilities {
	// DDL 仅对「允许编辑」的本地 SQLite 会话开放（2026-11-22 作者拍板：支持从零建库建表）；
	// 只读会话被 checkBatch 的 editable 门挡住，MySQL 驱动保持 DDL=false 恒拒。
	return Capabilities{Transaction: true, Editable: true, DDL: true}
}

// CreateSQLite 新建一个空的 SQLite 库文件（用户刚在保存对话框选的路径；
// 已存在即报错，绝不覆盖——添加已有库文件走「SQLite 库文件…」入口）。
// buildSQLiteDSN 的 mode=rw 不会创建新文件，所以先用 O_CREATE|O_EXCL 落一个 0 字节
// 文件（SQLite 把 0 字节文件当空库；journal_mode 是持久属性，执行它即写入文件头落盘）。
func CreateSQLite(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("路径不能为空")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("文件已存在：%s（要添加已有库请用「SQLite 库文件…」）", path)
		}
		return fmt.Errorf("无法创建文件：%w", err)
	}
	_ = f.Close()
	db, err := sql.Open("sqlite", buildSQLiteDSN(path, false, false))
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// 0 字节文件还不算「数据库」：header（100 字节）要靠首次真实写事务落盘。
	// 建一张初始化表再删掉——落盘后 sqlite_master 逻辑为空，仍是干净的 0 表空库。
	for _, stmt := range []string{"CREATE TABLE _cadt_init (x TEXT)", "DROP TABLE _cadt_init"} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			_ = os.Remove(path) // 创建失败不留半截文件
			return fmt.Errorf("创建数据库失败：%w", err)
		}
	}
	return nil
}

// buildSQLiteDSN 构造 modernc 驱动的 file: URI。路径做最小转义（% ? #）后 ToSlash，
// 其余原样保留（Windows 盘符路径 D:/x/y.db 驱动自己会处理）。
func buildSQLiteDSN(path string, readOnly, immutable bool) string {
	p := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(filepath.ToSlash(path))
	var b strings.Builder
	b.WriteString("file:")
	b.WriteString(p)
	add := func(k, v string) {
		if strings.Contains(b.String(), "?") {
			b.WriteString("&")
		} else {
			b.WriteString("?")
		}
		b.WriteString(k)
		b.WriteString("=")
		b.WriteString(v)
	}
	if readOnly {
		add("mode", "ro")
	} else {
		add("mode", "rw")
	}
	if immutable {
		add("immutable", "1")
	}
	add("_pragma", "busy_timeout(5000)")
	return b.String()
}

func (sqliteDriver) Open(ctx context.Context, spec openSpec) (*dbSession, error) {
	info, err := os.Stat(spec.Path)
	if err != nil {
		return nil, fmt.Errorf("SQLite 文件不可访问：%w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("目标是目录，不是数据库文件：%s", spec.Path)
	}
	tryOpen := func(ro, immutable bool) (*sql.DB, error) {
		db, err := sql.Open("sqlite", buildSQLiteDSN(spec.Path, ro, immutable))
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1) // 浏览语义是串行查询；单连接避免本进程内 SQLITE_BUSY
		pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := db.PingContext(pingCtx); err != nil {
			_ = db.Close()
			return nil, err
		}
		return db, nil
	}
	ro := !spec.AllowEdit
	db, err := tryOpen(ro, false)
	immutable := false
	if err != nil && ro {
		// WAL 库对 -wal/-shm 无读权限时 mode=ro 失败；immutable 兜底并显式标记（不静默降级）
		if db2, err2 := tryOpen(true, true); err2 == nil {
			db = db2
			immutable = true
			err = nil
			logWarn("SQLite 以 immutable 兜底打开（数据可能不反映其他进程的写入）：%s", spec.Path)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("SQLite 打开失败（若文件正被其他进程写入，请先关闭写入方）：%w", err)
	}
	return &dbSession{
		kind:      kindSQLite,
		name:      filepath.Base(spec.Path),
		editable:  spec.AllowEdit,
		immutable: immutable,
		caps:      sqliteDriver{}.Capabilities(),
		db:        db,
	}, nil
}

// ---------- 元数据（L1 / L2） ----------

func sqliteListObjects(ctx context.Context, s *dbSession, _ string) ([]DBObject, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DBObject{}
	for rows.Next() {
		var o DBObject
		if err := rows.Scan(&o.Name, &o.Kind); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func sqliteDescribe(ctx context.Context, s *dbSession, _, table string) (*DBTableMeta, error) {
	meta := &DBTableMeta{Table: table, Kind: "table"}
	// 列定义（pk 列的值是主键序号：1 为第一主键列）
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info("+quoteIdent(kindSQLite, table)+")")
	if err != nil {
		return nil, err
	}
	type pkEntry struct {
		name    string
		ordinal int
	}
	var pks []pkEntry
	for rows.Next() {
		var cid int
		var name, colType sql.NullString
		var notNull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err != nil {
			rows.Close()
			return nil, err
		}
		if name.String == "" {
			continue
		}
		var defaultPtr *string
		if dflt.Valid {
			v := dflt.String
			defaultPtr = &v
		}
		meta.Columns = append(meta.Columns, ColumnMeta{
			Name:    name.String,
			Type:    colType.String,
			NotNull: notNull != 0,
			Default: defaultPtr,
		})
		if pk > 0 {
			pks = append(pks, pkEntry{name: name.String, ordinal: pk})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// 主键按声明的序号排（组合主键顺序影响 WHERE 拼装与显示）
	for i := 0; i < len(pks); i++ {
		for j := i + 1; j < len(pks); j++ {
			if pks[j].ordinal < pks[i].ordinal {
				pks[i], pks[j] = pks[j], pks[i]
			}
		}
		meta.PK = append(meta.PK, pks[i].name)
	}
	// 索引（origin=pk 与主键信息重复，跳过）
	idxRows, err := s.db.QueryContext(ctx, "PRAGMA index_list("+quoteIdent(kindSQLite, table)+")")
	if err != nil {
		return nil, err
	}
	type idxInfo struct {
		name   string
		unique bool
	}
	var idxList []idxInfo
	for idxRows.Next() {
		var seq int
		var name string
		var unique int
		var origin string
		var partial int
		if err := idxRows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			idxRows.Close()
			return nil, err
		}
		if origin == "pk" {
			continue
		}
		idxList = append(idxList, idxInfo{name: name, unique: unique != 0})
	}
	idxErr := idxRows.Err()
	idxRows.Close()
	if idxErr != nil {
		return nil, idxErr
	}
	for _, idx := range idxList {
		cols, err := sqliteIndexColumns(ctx, s, table, idx.name)
		if err != nil {
			return nil, err
		}
		meta.Indexes = append(meta.Indexes, IndexMeta{Name: idx.name, Unique: idx.unique, Columns: cols})
	}
	fks, err := sqliteForeignKeys(ctx, s, table)
	if err != nil {
		return nil, err
	}
	meta.ForeignKeys = fks
	return meta, nil
}

// sqliteForeignKeys 读取外键约束并按 id/seq 聚合复合外键；引用列未显式写出时保留空列表。
func sqliteForeignKeys(ctx context.Context, s *dbSession, table string) ([]ForeignKeyMeta, error) {
	rows, err := s.db.QueryContext(ctx, "PRAGMA foreign_key_list("+quoteIdent(kindSQLite, table)+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type fkRow struct {
		id, seq            int
		table, from, to    string
		onUpdate, onDelete string
	}
	var raw []fkRow
	for rows.Next() {
		var r fkRow
		var refCol sql.NullString
		if err := rows.Scan(&r.id, &r.seq, &r.table, &r.from, &refCol, &r.onUpdate, &r.onDelete, new(string)); err != nil {
			return nil, err
		}
		r.to = refCol.String
		raw = append(raw, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(raw, func(i, j int) bool {
		if raw[i].id != raw[j].id {
			return raw[i].id < raw[j].id
		}
		return raw[i].seq < raw[j].seq
	})
	out := []ForeignKeyMeta{}
	lastID := -1
	for _, r := range raw {
		if r.id != lastID {
			out = append(out, ForeignKeyMeta{RefTable: r.table, OnUpdate: r.onUpdate, OnDelete: r.onDelete})
			lastID = r.id
		}
		fk := &out[len(out)-1]
		fk.Columns = append(fk.Columns, r.from)
		if r.to != "" {
			fk.RefColumns = append(fk.RefColumns, r.to)
		}
	}
	return out, nil
}

func sqliteIndexColumns(ctx context.Context, s *dbSession, table, index string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		"PRAGMA index_info("+quoteIdent(kindSQLite, index)+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var seqno int
		var cid sql.NullInt64
		var name sql.NullString
		if err := rows.Scan(&seqno, &cid, &name); err != nil {
			return nil, err
		}
		out = append(out, name.String) // 表达式索引列为 NULL，展示为空
	}
	return out, rows.Err()
}

func sqliteServerVersion(ctx context.Context, s *dbSession) (string, error) {
	var v string
	if err := s.db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&v); err != nil {
		return "", err
	}
	return "SQLite " + v, nil
}
