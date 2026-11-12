package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func importSQLText(t *testing.T, kind, text string) (*App, SQLImportInfo) {
	t.Helper()
	app := &App{}
	info, err := app.SQLImport("", kind, "utf-8", text, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.SQLClose(info.ID) })
	return app, info
}

func TestSQLImportCSVAndQuery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data.csv")
	content := "name,age,score\nalice,30,88.5\nbob,25,92\ncarol,,77.5\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	info, err := app.SQLImport(path, "csv", "utf-8", "", false)
	if err != nil {
		t.Fatal(err)
	}
	defer app.SQLClose(info.ID)
	if info.Rows != 3 || len(info.Columns) != 3 {
		t.Fatalf("info = %+v", info)
	}
	result, err := app.SQLQuery(info.ID, "SELECT name, age FROM t ORDER BY age DESC", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 3 {
		t.Fatalf("rows = %+v", result.Rows)
	}
	if result.Rows[0][0] != "alice" || result.Rows[0][1] != "30" {
		t.Fatalf("首行 = %+v", result.Rows[0])
	}
	if result.Rows[2][1] != "" || !result.Nulls[2][1] {
		t.Fatalf("空值应为 NULL：%+v nulls=%+v", result.Rows[2], result.Nulls[2])
	}
	// 数值列应能按数值排序/聚合
	sum, err := app.SQLQuery(info.ID, "SELECT sum(age) AS s FROM t", 10)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Rows[0][0] != "55" {
		t.Fatalf("sum(age) = %q", sum.Rows[0][0])
	}
	limited, err := app.SQLQuery(info.ID, "SELECT * FROM t", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.Rows) != 2 || !limited.Truncated {
		t.Fatalf("limit 结果 = %d truncated=%v", len(limited.Rows), limited.Truncated)
	}
	if _, err := app.SQLQuery(info.ID, "SELECT * FROM missing_table", 10); err == nil {
		t.Fatal("错误 SQL 应报错")
	}
}

func TestSQLImportTSVAndDirtyHeaders(t *testing.T) {
	content := "id\t\tname\n1\tx\ta\n2\ty\tb\n"
	app, info := importSQLText(t, "tsv", content)
	if len(info.Columns) != 3 || info.Columns[1] != "col2" {
		t.Fatalf("columns = %+v", info.Columns)
	}
	result, err := app.SQLQuery(info.ID, "SELECT id, name FROM t ORDER BY id", 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0][0] != "1" || result.Rows[1][1] != "b" {
		t.Fatalf("rows = %+v", result.Rows)
	}
}

func TestSQLImportJSONL(t *testing.T) {
	content := strings.Join([]string{
		`{"name":"a","age":1,"meta":{"x":1}}`,
		`{"name":"b","age":2}`,
	}, "\n") + "\n"
	app, info := importSQLText(t, "jsonl", content)
	if info.Rows != 2 {
		t.Fatalf("rows = %d", info.Rows)
	}
	result, err := app.SQLQuery(info.ID, "SELECT name, age, meta FROM t ORDER BY age DESC", 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0][0] != "b" || result.Rows[0][1] != "2" {
		t.Fatalf("rows = %+v", result.Rows)
	}
	if result.Rows[1][0] != "a" || !strings.Contains(result.Rows[1][2], `"x":1`) {
		t.Fatalf("嵌套值应存 JSON 文本：%+v", result.Rows[1])
	}
	jsonResult, err := app.SQLQuery(info.ID, `SELECT json_extract(meta,'$.x') AS x FROM t WHERE name='a'`, 10)
	if err != nil {
		t.Fatal(err)
	}
	if jsonResult.Rows[0][0] != "1" {
		t.Fatalf("json_extract = %+v", jsonResult.Rows)
	}
}

func TestSQLImportJSONLFallback(t *testing.T) {
	app, info := importSQLText(t, "jsonl", "[1,2]\n[3,4]\n")
	if len(info.Columns) != 1 || info.Columns[0] != "data" {
		t.Fatalf("columns = %+v", info.Columns)
	}
	result, err := app.SQLQuery(info.ID, "SELECT data FROM t ORDER BY data", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 2 || !strings.Contains(result.Rows[0][0], "[1,2]") {
		t.Fatalf("rows = %+v", result.Rows)
	}
}

func TestSQLImportEmpty(t *testing.T) {
	app := &App{}
	if _, err := app.SQLImport("", "csv", "utf-8", "   \n", true); err == nil {
		t.Fatal("空内容应报错")
	}
}

func TestSQLCloseRemovesTempFile(t *testing.T) {
	app, info := importSQLText(t, "csv", "a,b\n1,2\n")
	sqlSessionsMu.Lock()
	session := sqlSessions[info.ID]
	sqlSessionsMu.Unlock()
	if session == nil {
		t.Fatal("session 不存在")
	}
	path := session.path
	if err := app.SQLClose(info.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("临时库未删除：%v", err)
	}
	if _, err := app.SQLQuery(info.ID, "SELECT * FROM t", 10); err == nil {
		t.Fatal("关闭后查询应报错")
	}
}

func TestSQLDML(t *testing.T) {
	app, info := importSQLText(t, "csv", "a\n1\n")
	if _, err := app.SQLQuery(info.ID, "UPDATE t SET a=2", 10); err != nil {
		t.Fatalf("DML 查询报错：%v", err)
	}
	result, err := app.SQLQuery(info.ID, "SELECT a FROM t", 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0][0] != "2" {
		t.Fatalf("rows = %+v", result.Rows)
	}
}

func TestSQLCSVPreservesNumericText(t *testing.T) {
	app, info := importSQLText(t, "csv", "code,value\n1,00123\n2,30.0\n3,+1\n")
	result, err := app.SQLQuery(info.ID, "SELECT value FROM t ORDER BY code", 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"00123", "30.0", "+1"}
	for i, expected := range want {
		if result.Rows[i][0] != expected {
			t.Fatalf("第 %d 行 = %q, want %q（CSV 原样保留）", i, result.Rows[i][0], expected)
		}
	}
}

func TestSQLJSONLFallbackCountsAllRows(t *testing.T) {
	app, info := importSQLText(t, "jsonl", "[1]\n{\"a\":2}\n[3]\n")
	if info.Rows != 3 || info.Truncated {
		t.Fatalf("info = %+v，回退模式应统计全部 3 行且未截断", info)
	}
	result, err := app.SQLQuery(info.ID, "SELECT count(*) FROM t", 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rows[0][0] != "3" {
		t.Fatalf("count(*) = %q, want 3（回退模式不能只统计到出错行）", result.Rows[0][0])
	}
}

func TestSQLRejectsStatementsWritingOutsideSession(t *testing.T) {
	app, info := importSQLText(t, "csv", "a\n1\n")
	for _, q := range []string{
		"ATTACH DATABASE 'C:/tmp/cadt-escape.db' AS x",
		"detach database x",
		"VACUUM INTO 'C:/tmp/cadt-escape.db'",
		"SELECT 1; /* c */ VACUUM INTO 'x.db'",
	} {
		if _, err := app.SQLQuery(info.ID, q, 10); err == nil {
			t.Fatalf("%q 应被拒绝（能把文件写到临时副本之外）", q)
		}
	}
	// 注释与字符串字面量里的关键词不误判
	if _, err := app.SQLQuery(info.ID, "SELECT 'ATTACH' AS k -- VACUUM", 10); err != nil {
		t.Fatalf("字面量误判：%v", err)
	}
	// 临时副本上的 DML 仍然允许（见 TestSQLDML）
	if _, err := app.SQLQuery(info.ID, "UPDATE t SET a=9", 10); err != nil {
		t.Fatalf("临时副本 DML 不应被误拦：%v", err)
	}
}
