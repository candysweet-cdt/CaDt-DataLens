package dbclient

// dbclient_test.go：会话生命周期 + SQLite 只读/编辑全链路（真实临时库文件，纯 Go 驱动）。

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// makeTestDB 造一个真实 SQLite 库：products 有主键，logs 无主键（验证「无主键一律只读」）。
func makeTestDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("打开测试库失败：%v", err)
	}
	defer db.Close()
	stmts := []string{
		`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, note TEXT)`,
		`CREATE TABLE logs (ts TEXT, msg TEXT)`,
		`INSERT INTO products (id, name, price, note) VALUES (1, 'alpha', 1.5, NULL)`,
		`INSERT INTO products (id, name, price, note) VALUES (2, 'beta%', 2.5, 'x')`,
		`INSERT INTO products (id, name, price, note) VALUES (3, 'gamma', 3.5, 'y')`,
		`INSERT INTO logs (ts, msg) VALUES ('2026-01-01', 'hello')`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("初始化测试库失败：%v（%s）", err, s)
		}
	}
	return path
}

func openFor(t *testing.T, path string, allowEdit bool) SessionInfo {
	t.Helper()
	info, err := openSession(openSpec{Kind: kindSQLite, Path: path, AllowEdit: allowEdit})
	if err != nil {
		t.Fatalf("openSession 失败：%v", err)
	}
	return info
}

func TestSQLiteReadOnlyFlow(t *testing.T) {
	path := makeTestDB(t)
	info := openFor(t, path, false)
	defer func() { _ = CloseSession(info.ID) }()
	if info.Editable {
		t.Fatal("只读会话不应标记 editable")
	}

	dbs, err := listDatabasesMeta(mustSession(t, info.ID))
	if err != nil || len(dbs) != 1 || dbs[0] != "main" {
		t.Fatalf("listDatabases = %v, %v", dbs, err)
	}

	objects, err := listObjectsMeta(mustSession(t, info.ID), "")
	if err != nil {
		t.Fatalf("listObjects 失败：%v", err)
	}
	if len(objects) != 2 {
		t.Fatalf("对象数 = %d，want 2（products/logs）", len(objects))
	}

	s := mustSession(t, info.ID)
	meta, err := describeMeta(s, "", "products", false)
	if err != nil {
		t.Fatalf("describe 失败：%v", err)
	}
	if len(meta.PK) != 1 || meta.PK[0] != "id" {
		t.Fatalf("products 主键 = %v，want [id]", meta.PK)
	}
	logMeta, err := describeMeta(s, "", "logs", false)
	if err != nil {
		t.Fatalf("describe logs 失败：%v", err)
	}
	if logMeta.Editable {
		t.Fatal("无主键表不应可编辑")
	}

	// 只读查询 OK
	out, err := Query(info.ID, "q1", "SELECT id, name FROM products ORDER BY id", false, 100)
	if err != nil || out.Status != "ok" {
		t.Fatalf("只读查询失败：%v / %+v", err, out)
	}
	if len(out.Result.Rows) != 3 || out.Result.Rows[0][1] != "alpha" {
		t.Fatalf("查询结果异常：%+v", out.Result)
	}

	// 只读拒绝写（逐条 + 批量夹带 + CTE bypass + PRAGMA 赋值）
	roRejects := []string{
		"DELETE FROM products",
		"SELECT 1; DELETE FROM products",
		"WITH x AS (DELETE FROM products RETURNING *) SELECT * FROM x",
		"UPDATE products SET name='x' WHERE id=1",
		"PRAGMA journal_mode = WAL",
		"ATTACH DATABASE 'other.db' AS o",
		"DROP TABLE products",
	}
	for _, q := range roRejects {
		if _, err := Query(info.ID, "q2", q, false, 100); err == nil {
			t.Fatalf("只读会话未拒绝：%s", q)
		} else if !errors.Is(err, ErrReadOnlySession) && !strings.Contains(err.Error(), "DDL") {
			t.Fatalf("拒绝原因异常（%s）：%v", q, err)
		}
	}
}

func TestSQLiteDescribeForeignKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fk.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b))`,
		`CREATE TABLE child (id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER,
			FOREIGN KEY (pa, pb) REFERENCES parent(a, b) ON UPDATE CASCADE ON DELETE SET NULL)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			_ = db.Close()
			t.Fatalf("建外键测试库失败：%v", err)
		}
	}
	_ = db.Close()
	info := openFor(t, path, false)
	defer func() { _ = CloseSession(info.ID) }()
	meta, err := describeMeta(mustSession(t, info.ID), "", "child", false)
	if err != nil {
		t.Fatalf("describe child：%v", err)
	}
	if len(meta.ForeignKeys) != 1 {
		t.Fatalf("外键数 = %d，want 1：%+v", len(meta.ForeignKeys), meta.ForeignKeys)
	}
	fk := meta.ForeignKeys[0]
	if strings.Join(fk.Columns, ",") != "pa,pb" || fk.RefTable != "parent" || strings.Join(fk.RefColumns, ",") != "a,b" ||
		fk.OnUpdate != "CASCADE" || fk.OnDelete != "SET NULL" {
		t.Fatalf("外键元数据不符：%+v", fk)
	}
}

func TestBrowseSortFilterPushdown(t *testing.T) {
	path := makeTestDB(t)
	info := openFor(t, path, false)
	defer func() { _ = CloseSession(info.ID) }()

	// 排序下推
	res, err := Browse(info.ID, BrowseRequest{Table: "products", SortColumn: "id", SortDesc: true, Limit: 10})
	if err != nil {
		t.Fatalf("Browse 失败：%v", err)
	}
	if res.Rows[0][0] != "3" {
		t.Fatalf("排序下推异常，首行 id = %s", res.Rows[0][0])
	}

	// 筛选下推：contains（带通配符转义——数据里的 beta% 不应被当通配符）
	res, err = Browse(info.ID, BrowseRequest{Table: "products",
		Filters: []FilterCond{{Column: "name", Op: "contains", Value: "beta%"}}})
	if err != nil {
		t.Fatalf("contains 筛选失败：%v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][1] != "beta%" {
		t.Fatalf("contains 筛选异常：%+v", res.Rows)
	}

	// 筛选下推：null / eq 组合
	res, err = Browse(info.ID, BrowseRequest{Table: "products",
		Filters: []FilterCond{{Column: "note", Op: "null"}}})
	if err != nil || len(res.Rows) != 1 {
		t.Fatalf("null 筛选异常：%v / %+v", err, res.Rows)
	}

	// 分页 + 截断标记（请求 2 行，库里 3 行）
	res, err = Browse(info.ID, BrowseRequest{Table: "products", Limit: 2, Offset: 0})
	if err != nil {
		t.Fatalf("分页失败：%v", err)
	}
	if len(res.Rows) != 2 || !res.Truncated {
		t.Fatalf("截断标记异常：rows=%d truncated=%v", len(res.Rows), res.Truncated)
	}
	// OFFSET 翻页
	res, err = Browse(info.ID, BrowseRequest{Table: "products", Limit: 2, Offset: 2})
	if err != nil || len(res.Rows) != 1 {
		t.Fatalf("翻页异常：%v / %d 行", err, len(res.Rows))
	}

	// 列名白名单：元数据之外的列直接拒
	if _, err := Browse(info.ID, BrowseRequest{Table: "products",
		Filters: []FilterCond{{Column: "1=1); DROP TABLE products;--", Op: "eq", Value: "x"}}}); err == nil {
		t.Fatal("非法列名未被拒绝")
	}
	if _, err := Browse(info.ID, BrowseRequest{Table: "products", SortColumn: "price; DROP TABLE x"}); err == nil {
		t.Fatal("非法排序列未被拒绝")
	}
}

func TestBrowseOrderCols(t *testing.T) {
	path := makeTestDB(t)
	info := openFor(t, path, true)
	defer func() { _ = CloseSession(info.ID) }()

	// 多列排序：name DESC, id ASC——全部下推拼 ORDER BY
	res, err := Browse(info.ID, BrowseRequest{Table: "products",
		OrderCols: []OrderCol{{Column: "name", Desc: true}, {Column: "id"}}, Limit: 10})
	if err != nil || len(res.Rows) < 2 {
		t.Fatalf("多列排序浏览失败：%v / %d 行", err, len(res.Rows))
	}
	// 坏列拒绝（元数据白名单）
	_, err = Browse(info.ID, BrowseRequest{Table: "products", OrderCols: []OrderCol{{Column: "nope"}}})
	if err == nil || !strings.Contains(err.Error(), "列不存在") {
		t.Fatalf("ORDER BY 坏列未拒绝：%v", err)
	}
	// 混合方向的真实顺序抽查：name DESC 时首行应为 name 最大值
	if res.Rows[0][1] < res.Rows[len(res.Rows)-1][1] {
		t.Fatalf("name DESC 顺序不对：首行 %v 末行 %v", res.Rows[0][1], res.Rows[len(res.Rows)-1][1])
	}
}

func TestBrowseCancel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "slow.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE VIEW slow AS WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) AS n FROM c`)
	_ = db.Close()
	if err != nil {
		t.Fatalf("建慢查询视图失败：%v", err)
	}
	info := openFor(t, path, false)
	defer func() { _ = CloseSession(info.ID) }()
	s := mustSession(t, info.ID)
	done := make(chan error, 1)
	go func() {
		_, err := Browse(info.ID, BrowseRequest{Table: "slow", Limit: 1, QueryID: "browse-cancel"})
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		_, running := s.active["browse-cancel"]
		s.mu.Unlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("浏览查询未登记取消句柄")
		}
		time.Sleep(time.Millisecond)
	}
	if err := Cancel(info.ID, "browse-cancel"); err != nil {
		t.Fatalf("取消浏览失败：%v", err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("浏览取消后应返回 context.Canceled，got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("浏览查询取消后未及时退出")
	}
}

func TestCreateSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new.db")
	if err := CreateSQLite(path); err != nil {
		t.Fatalf("CreateSQLite 失败：%v", err)
	}
	st, err := os.Stat(path)
	if err != nil || st.Size() == 0 {
		t.Fatalf("库文件未落盘：stat=%v / size=%d", err, st.Size())
	}
	// 已存在报错，绝不覆盖
	if err := CreateSQLite(path); err == nil || !strings.Contains(err.Error(), "已存在") {
		t.Fatalf("重复创建未报「已存在」：%v", err)
	}
	// 新库可正常打开浏览，且 editable 会话能直接建表（DDL 放行）
	info := openFor(t, path, true)
	defer func() { _ = CloseSession(info.ID) }()
	dbs, err := ListDatabases(info.ID)
	if err != nil || len(dbs) == 0 {
		t.Fatalf("空库打开失败：%v / %v", err, dbs)
	}
	out, err := Query(info.ID, "q1", "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", false, 10)
	if err != nil || out.Status != "ok" {
		t.Fatalf("空库建表失败（DDL 应放行）：%v / %+v", err, out)
	}
}

func TestSQLiteEditableFlow(t *testing.T) {
	path := makeTestDB(t)
	info := openFor(t, path, true)
	defer func() { _ = CloseSession(info.ID) }()
	if !info.Editable {
		t.Fatal("编辑会话应标记 editable")
	}

	// 普通 UPDATE 直接执行
	out, err := Query(info.ID, "q1", "UPDATE products SET name='zzz' WHERE id=1", false, 100)
	if err != nil || out.Status != "ok" || out.Writes != 1 {
		t.Fatalf("UPDATE 失败：%v / %+v", err, out)
	}

	// 缺 WHERE → 两阶段确认
	out, err = Query(info.ID, "q2", "UPDATE products SET price=0", false, 100)
	if err != nil || out.Status != "confirm" || out.Confirm != confirmMissingWhere {
		t.Fatalf("缺 WHERE 未触发确认：%v / %+v", err, out)
	}
	out, err = Query(info.ID, "q3", "UPDATE products SET price=0", true, 100)
	if err != nil || out.Status != "ok" {
		t.Fatalf("确认后执行失败：%v / %+v", err, out)
	}

	// 危险语句 → 两阶段确认（不实际执行 ATTACH）
	out, err = Query(info.ID, "q4", "ATTACH DATABASE 'nope.db' AS nope", false, 100)
	if err != nil || out.Status != "confirm" || out.Confirm != confirmDanger {
		t.Fatalf("ATTACH 未触发确认：%v / %+v", err, out)
	}

	// SQLite editable 会话 DDL 已开放（2026-11-22 作者拍板）：DROP 确认后真实执行
	if _, err := Query(info.ID, "q5", "DROP TABLE logs", true, 100); err != nil {
		t.Fatalf("确认后 DROP TABLE 失败（DDL 应放行）：%v", err)
	}

	// CTE bypass 在编辑会话同样进确认（缺 WHERE）
	out, err = Query(info.ID, "q6", "WITH x AS (DELETE FROM products RETURNING *) SELECT * FROM x", false, 100)
	if err != nil || out.Status != "confirm" || out.Confirm != confirmMissingWhere {
		t.Fatalf("数据变更 CTE 未触发确认：%v / %+v", err, out)
	}
}

func TestApplyChangesAndConflict(t *testing.T) {
	path := makeTestDB(t)
	info := openFor(t, path, true)
	defer func() { _ = CloseSession(info.ID) }()
	s := mustSession(t, info.ID)
	if _, err := describeMeta(s, "", "products", false); err != nil {
		t.Fatalf("describe products 失败：%v", err)
	}

	// 更新：主键定位 + 旧值校验（NULL 旧值走 IS NULL）
	got, err := PreviewChanges(info.ID, TableChanges{Table: "products", Updates: []CellUpdate{
		{Keys: map[string]string{"id": "1"}, Column: "note", OldValue: nil, NewValue: strPtr("hello")},
	}})
	if err != nil || len(got) != 1 {
		t.Fatalf("预览失败：%v / %d 条", err, len(got))
	}
	if !strings.Contains(got[0].SQL, `"note" IS NULL`) {
		t.Fatalf("预览 SQL 未用 IS NULL 处理 NULL 旧值：%s", got[0].SQL)
	}
	res, err := ApplyChanges(info.ID, TableChanges{Table: "products", Updates: []CellUpdate{
		{Keys: map[string]string{"id": "1"}, Column: "note", OldValue: nil, NewValue: strPtr("hello")},
	}})
	if err != nil || res.Updates != 1 {
		t.Fatalf("提交失败：%v / %+v", err, res)
	}
	out, _ := Query(info.ID, "q1", "SELECT note FROM products WHERE id=1", false, 10)
	if out.Result.Rows[0][0] != "hello" {
		t.Fatalf("回读异常：%+v", out.Result.Rows)
	}

	// 冲突：旧值对不上 → 整体回滚
	stale := "changed-by-other"
	_, err = ApplyChanges(info.ID, TableChanges{Table: "products", Updates: []CellUpdate{
		{Keys: map[string]string{"id": "1"}, Column: "note", OldValue: &stale, NewValue: strPtr("nope")},
	}})
	if err == nil || !strings.Contains(err.Error(), "冲突") {
		t.Fatalf("冲突未检出：%v", err)
	}
	out, _ = Query(info.ID, "q2", "SELECT note FROM products WHERE id=1", false, 10)
	if out.Result.Rows[0][0] != "hello" {
		t.Fatalf("冲突后数据被改（未回滚）：%+v", out.Result.Rows)
	}

	// 插入 + 删除
	res, err = ApplyChanges(info.ID, TableChanges{Table: "products",
		Inserts: []RowInsert{{Values: map[string]*string{
			"id": strPtr("9"), "name": strPtr("delta"),
		}}},
		Deletes: []RowDelete{{Keys: map[string]string{"id": "2"}}},
	})
	if err != nil || res.Inserts != 1 || res.Deletes != 1 {
		t.Fatalf("插入/删除失败：%v / %+v", err, res)
	}

	// 无主键表拒编辑
	if _, err = ApplyChanges(info.ID, TableChanges{Table: "logs", Deletes: []RowDelete{{Keys: map[string]string{"ts": "2026-01-01"}}}}); err == nil || !strings.Contains(err.Error(), "主键") {
		t.Fatalf("无主键表未被拒：%v", err)
	}

	// 键列不属于主键 → 拒
	_, err = ApplyChanges(info.ID, TableChanges{Table: "products",
		Deletes: []RowDelete{{Keys: map[string]string{"name": "alpha"}}}})
	if err == nil {
		t.Fatal("非主键定位列未被拒")
	}
}

func TestSessionLimitAndEviction(t *testing.T) {
	path := makeTestDB(t)
	ids := make([]string, 0, maxSessions+1)
	for i := 0; i < maxSessions; i++ {
		ids = append(ids, openFor(t, path, false).ID)
	}
	if _, err := openSession(openSpec{Kind: kindSQLite, Path: path}); err == nil ||
		!strings.Contains(err.Error(), "上限") {
		t.Fatalf("会话上限未拦截：%v", err)
	}
	// 把最早一个会话标记为超时空闲 → 新会话应回收它而不是拒绝
	var victim *dbSession
	sessionsMu.Lock()
	for _, s := range sessions {
		if s.id == ids[0] {
			victim = s
		}
	}
	if victim != nil {
		victim.mu.Lock()
		victim.lastUsed = time.Now().Add(-idleCloseAfter - time.Minute)
		victim.mu.Unlock()
	}
	sessionsMu.Unlock()
	info, err := openSession(openSpec{Kind: kindSQLite, Path: path})
	if err != nil {
		t.Fatalf("回收空闲会话后仍拒绝：%v", err)
	}
	defer func() { _ = CloseSession(info.ID) }()
	if _, err := getSession(ids[0]); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("被回收会话仍可用：%v", err)
	}
	// 清场
	for _, id := range ids[1:] {
		_ = CloseSession(id)
	}
}

func TestCancel(t *testing.T) {
	path := makeTestDB(t)
	info := openFor(t, path, false)
	defer func() { _ = CloseSession(info.ID) }()
	if err := Cancel(info.ID, "not-running"); err == nil {
		t.Fatal("取消不存在的查询应报错")
	}
	// 真实取消：跑一个可控的慢递归查询，主 goroutine 等它登记后取消
	s := mustSession(t, info.ID)
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		defer cancel()
		s.registerQuery("slow", cancel)
		defer s.unregisterQuery("slow")
		rows, err := s.db.QueryContext(ctx, "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c")
		if err != nil {
			done <- err
			return
		}
		rows.Close()
		done <- nil
	}()
	time.Sleep(50 * time.Millisecond)
	if err := Cancel(info.ID, "slow"); err != nil {
		t.Fatalf("取消失败：%v", err)
	}
	if err := <-done; err == nil {
		t.Fatal("取消后查询应当报错中断")
	}
}

func mustSession(t *testing.T, id string) *dbSession {
	t.Helper()
	s, err := getSession(id)
	if err != nil {
		t.Fatalf("getSession 失败：%v", err)
	}
	return s
}

func strPtr(v string) *string { return &v }
