package dbclient

// guard_test.go：SQL 分类器与语句拆分的表驱动测试。
//
// 重点回归的是评审确认的关键盲区（方案 §5.1）：数据变更 CTE（WITH x AS (DELETE …
// RETURNING …) SELECT …）不得按首关键字误判成只读；未知语句 fail closed 按写拒绝。

import (
	"errors"
	"strings"
	"testing"
)

func class(v stmtVerdict) string {
	switch v.class {
	case classRead:
		return "read"
	case classWrite:
		return "write"
	case classDDL:
		return "ddl"
	case classCtrl:
		return "ctrl"
	}
	return "?"
}

func TestClassifyStatement(t *testing.T) {
	tests := []struct {
		name        string
		stmt        string
		dialect     string
		wantClass   string
		wantDanger  bool
		wantMissing bool
		wantUnknown bool
	}{
		// 基础读
		{name: "select", stmt: "SELECT * FROM users", wantClass: "read"},
		{name: "大小写混排", stmt: "ExPlain SeLeCt 1", wantClass: "read"},
		// EXPLAIN ANALYZE 会真实执行语句（MySQL 8.0.19+ 支持 DML、SQLite 3.29+ 同名）
		{name: "explain analyze 按写", stmt: "EXPLAIN ANALYZE DELETE FROM t WHERE id=1", wantClass: "write"},
		{name: "explain analyze 全表缺 where", stmt: "EXPLAIN ANALYZE DELETE FROM t", wantClass: "write", wantMissing: true},
		{name: "普通 explain 仍是读", stmt: "EXPLAIN DELETE FROM t", wantClass: "read"},
		{name: "values 语句", stmt: "VALUES (1, 2)", wantClass: "read"},
		{name: "show", stmt: "SHOW TABLES", dialect: kindMySQL, wantClass: "read"},
		{name: "字符串里的写关键字", stmt: "SELECT 'DROP TABLE users'", wantClass: "read"},
		{name: "注释里的写关键字", stmt: "-- DELETE FROM t\nSELECT 1", wantClass: "read"},
		{name: "块注释", stmt: "/* DROP TABLE */ SELECT 1", wantClass: "read"},
		{name: "引号标识符", stmt: "SELECT \"delete\" FROM t", wantClass: "read"},

		// 写
		{name: "insert", stmt: "INSERT INTO t VALUES (1)", wantClass: "write"},
		{name: "replace", stmt: "REPLACE INTO t VALUES (1)", wantClass: "write"},
		{name: "update 带 where", stmt: "UPDATE t SET a=1 WHERE id=2", wantClass: "write"},
		{name: "delete 带 where", stmt: "DELETE FROM t WHERE id=2", wantClass: "write"},
		{name: "vacuum", stmt: "VACUUM", wantClass: "write"},
		{name: "analyze", stmt: "ANALYZE", wantClass: "write"},
		{name: "set", stmt: "SET session transaction_read_only = 0", dialect: kindMySQL, wantClass: "write"},
		{name: "use", stmt: "USE mydb", dialect: kindMySQL, wantClass: "write"},

		// 缺 WHERE / 恒真 WHERE（写放行会话需确认）
		{name: "update 缺 where", stmt: "UPDATE t SET a=1", wantClass: "write", wantMissing: true},
		{name: "delete 缺 where", stmt: "DELETE FROM t", wantClass: "write", wantMissing: true},
		{name: "where true", stmt: "DELETE FROM t WHERE TRUE", wantClass: "write", wantMissing: true},
		{name: "where 1", stmt: "DELETE FROM t WHERE 1", wantClass: "write", wantMissing: true},
		{name: "where 1=1", stmt: "DELETE FROM t WHERE 1=1", wantClass: "write", wantMissing: true},
		// 字面量自比的各种写法（旧实现只认 true / 1 / 1=1 三种）
		{name: "where 0=0", stmt: "DELETE FROM t WHERE 0=0", wantClass: "write", wantMissing: true},
		// 词法层丢弃运算符，`2>1` 与 `2<1` 无法区分：不做数值比较判定（宁可少报）
		{name: "where 2>1", stmt: "DELETE FROM t WHERE 2>1", wantClass: "write", wantMissing: false},
		{name: "where quoted", stmt: "DELETE FROM t WHERE 'a'='a'", wantClass: "write", wantMissing: true},
		// 列自比不是恒真（两列可能不等），不能误报
		{name: "where col=col", stmt: "DELETE FROM t WHERE a=a", wantClass: "write", wantMissing: false},
		{name: "子查询 where 不算顶层", stmt: "UPDATE t SET a=(SELECT b FROM u WHERE u.id=t.id)", wantClass: "write", wantMissing: true},
		{name: "where in 子查询", stmt: "DELETE FROM t WHERE id IN (SELECT id FROM u)", wantClass: "write"},

		// DDL
		{name: "create", stmt: "CREATE TABLE x (a INT)", wantClass: "ddl"},
		{name: "alter", stmt: "ALTER TABLE t ADD c INT", wantClass: "ddl"},
		{name: "drop 危险", stmt: "DROP TABLE users", wantClass: "ddl", wantDanger: true},
		{name: "truncate 危险", stmt: "TRUNCATE TABLE t", dialect: kindMySQL, wantClass: "ddl", wantDanger: true},

		// 危险写（写放行会话需确认）
		{name: "attach", stmt: "ATTACH DATABASE 'x.db' AS other", wantClass: "write", wantDanger: true},
		{name: "detach", stmt: "DETACH other", wantClass: "write", wantDanger: true},
		{name: "vacuum into", stmt: "VACUUM INTO 'backup.db'", wantClass: "write", wantDanger: true},
		{name: "call", stmt: "CALL do_something()", dialect: kindMySQL, wantClass: "write", wantDanger: true},
		{name: "grant", stmt: "GRANT ALL ON *.* TO 'u'@'%'", dialect: kindMySQL, wantClass: "write", wantDanger: true},
		{name: "load data", stmt: "LOAD DATA INFILE 'f' INTO TABLE t", dialect: kindMySQL, wantClass: "write", wantDanger: true},
		{name: "select into outfile", stmt: "SELECT * FROM t INTO OUTFILE '/tmp/x'", dialect: kindMySQL, wantClass: "write", wantDanger: true},
		{name: "select into 变量", stmt: "SELECT 1 INTO @v", dialect: kindMySQL, wantClass: "write"},

		// PRAGMA：白名单反向收口——引号名/库限定名/未知名字 fail closed
		{name: "pragma 查询", stmt: "PRAGMA table_info(t)", wantClass: "read"},
		{name: "pragma 名查询", stmt: "PRAGMA journal_mode", wantClass: "read"},
		{name: "pragma 白名单读", stmt: "PRAGMA user_version", wantClass: "read"},
		{name: "pragma 赋值", stmt: "PRAGMA journal_mode = WAL", wantClass: "write"},
		{name: "pragma wal_checkpoint", stmt: "PRAGMA wal_checkpoint", wantClass: "write"},
		{name: "pragma 引号名赋值 fail closed", stmt: `PRAGMA "journal_mode" = WAL`, wantClass: "write"},
		{name: "pragma 库限定 checkpoint", stmt: "PRAGMA main.wal_checkpoint", wantClass: "write"},
		{name: "pragma 未知名字 fail closed", stmt: "PRAGMA something_obscure", wantClass: "write"},

		// 事务控制（分类仍是 ctrl；控制台策略一律拒绝，见 checkBatch）
		{name: "begin", stmt: "BEGIN", wantClass: "ctrl"},
		{name: "start transaction", stmt: "START TRANSACTION", dialect: kindMySQL, wantClass: "ctrl"},
		{name: "commit", stmt: "COMMIT", wantClass: "ctrl"},

		// fail closed
		{name: "未知关键字", stmt: "FOOBAR t", wantClass: "write", wantUnknown: true},
		{name: "空语句", stmt: "   ", wantClass: "write", wantUnknown: true},

		// 数据变更 CTE：按首关键字分类会漏掉的 bypass 形态（评审 §三.1）。
		// 体里的 DELETE/UPDATE 全表作用也带 missingWhere（进确认流程）。
		{name: "CTE 包 DELETE", stmt: "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", wantClass: "write", wantMissing: true},
		{name: "CTE 包 UPDATE", stmt: "WITH x AS (UPDATE t SET a=1 RETURNING a) SELECT * FROM x", wantClass: "write", wantMissing: true},
		{name: "CTE 包 DELETE 带 where", stmt: "WITH x AS (DELETE FROM t WHERE id=1 RETURNING *) SELECT * FROM x", wantClass: "write"},
		{name: "CTE 只读 + 主语句 DELETE", stmt: "WITH x AS (SELECT 1) DELETE FROM t", wantClass: "write", wantMissing: true},
		{name: "普通 CTE", stmt: "WITH x AS (SELECT 1) SELECT * FROM x", wantClass: "read"},
		{name: "递归 CTE", stmt: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c LIMIT 5) SELECT * FROM c", wantClass: "read"},
		{name: "多 CTE 其一 DML", stmt: "WITH a AS (SELECT 1), b AS (DELETE FROM t RETURNING *) SELECT * FROM a", wantClass: "write", wantMissing: true},
		{name: "materialized CTE 只读", stmt: "WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x", wantClass: "read"},
		{name: "not materialized CTE", stmt: "WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x", wantClass: "read"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dialect := tt.dialect
			if dialect == "" {
				dialect = kindSQLite
			}
			got := classifyStatement(tt.stmt, dialect)
			if class(got) != tt.wantClass {
				t.Fatalf("class = %s, want %s（stmt: %s）", class(got), tt.wantClass, tt.stmt)
			}
			if got.danger != tt.wantDanger {
				t.Fatalf("danger = %v, want %v（stmt: %s）", got.danger, tt.wantDanger, tt.stmt)
			}
			if got.missingWhere != tt.wantMissing {
				t.Fatalf("missingWhere = %v, want %v（stmt: %s）", got.missingWhere, tt.wantMissing, tt.stmt)
			}
			if got.unknown != tt.wantUnknown {
				t.Fatalf("unknown = %v, want %v（stmt: %s）", got.unknown, tt.wantUnknown, tt.stmt)
			}
		})
	}
}

func TestSplitStatements(t *testing.T) {
	tests := []struct {
		name    string
		q       string
		dialect string
		want    []string
	}{
		{name: "两条", q: "SELECT 1; SELECT 2", want: []string{"SELECT 1", "SELECT 2"}},
		{name: "字符串里的分号", q: "SELECT ';' FROM t", want: []string{"SELECT ';' FROM t"}},
		{name: "注释里的分号", q: "SELECT 1 -- ; 注释\n; SELECT 2", want: []string{"SELECT 1", "SELECT 2"}},
		{name: "块注释里的分号", q: "SELECT /* ; */ 1; SELECT 2", want: []string{"SELECT 1", "SELECT 2"}},
		{name: "反引号标识符", q: "SELECT `a;b` FROM t", dialect: kindMySQL, want: []string{"SELECT `a;b` FROM t"}},
		{name: "方括号标识符", q: "SELECT [a;b] FROM t", want: []string{"SELECT [a;b] FROM t"}},
		{name: "mysql 反斜杠转义", q: `SELECT 'a\';b'; SELECT 2`, dialect: kindMySQL,
			want: []string{`SELECT 'a\';b'`, "SELECT 2"}},
		{name: "mysql # 注释", q: "SELECT 1 # ; 注释\n; SELECT 2", dialect: kindMySQL,
			want: []string{"SELECT 1", "SELECT 2"}},
		{name: "mysql 双横杠需跟空白", q: "SELECT a--b; SELECT 2", dialect: kindMySQL,
			want: []string{"SELECT a--b", "SELECT 2"}},
		{name: "sqlite 双横杠总是注释", q: "SELECT a--b\n; SELECT 2", dialect: kindSQLite,
			want: []string{"SELECT a", "SELECT 2"}},
		{name: "空语句丢弃", q: ";;;SELECT 1;;;", want: []string{"SELECT 1"}},
		// 尾随单个反斜杠（未闭合字符串）：回归 skipQuoted 越界 panic（MySQL 字符串反斜杠转义）
		{name: "mysql 尾随反斜杠", q: "SELECT 'a\\", dialect: kindMySQL,
			want: []string{"SELECT 'a\\"}},
		{name: "mysql 双引号尾随反斜杠", q: `SELECT "a\`, dialect: kindMySQL,
			want: []string{`SELECT "a\`}},
		{name: "sqlite 尾随反斜杠不是转义", q: "SELECT 'a\\'", want: []string{"SELECT 'a\\'"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dialect := tt.dialect
			if dialect == "" {
				dialect = kindSQLite
			}
			got := splitStatements(tt.q, dialect)
			if len(got) != len(tt.want) {
				t.Fatalf("拆出 %d 条 %v，want %d 条 %v", len(got), got, len(tt.want), tt.want)
			}
			// 拆分契约是 token 级内容：注释替换产生的连续空白不影响语义，比较时归一化
			norm := func(s string) string { return strings.Join(strings.Fields(s), " ") }
			for i := range got {
				if norm(got[i]) != norm(tt.want[i]) {
					t.Fatalf("第 %d 条 = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestCheckBatch(t *testing.T) {
	ro := false
	edit := true
	tests := []struct {
		name       string
		stmts      []string
		editable   bool
		confirmed  bool
		ddlAllowed bool
		wantErr    bool
		wantRO     bool
		wantDDL    bool
		wantCtrl   bool
		wantConf   string
	}{
		{name: "RO 放行读", stmts: []string{"SELECT 1", "PRAGMA table_info(t)"}, editable: ro},
		{name: "RO 拒写", stmts: []string{"SELECT 1", "DELETE FROM t"}, editable: ro,
			wantErr: true, wantRO: true},
		{name: "RO 拒 DDL", stmts: []string{"CREATE TABLE x (a int)"}, editable: ro, wantErr: true},
		{name: "事务控制语句拒绝（RO 会话）", stmts: []string{"BEGIN", "COMMIT"}, editable: ro,
			wantErr: true, wantCtrl: true},
		{name: "编辑会话事务控制同样拒", stmts: []string{"COMMIT"}, editable: edit,
			wantErr: true, wantCtrl: true},
		{name: "编辑会话缺 WHERE 需确认", stmts: []string{"DELETE FROM t"}, editable: edit,
			wantConf: confirmMissingWhere},
		{name: "编辑会话确认后放行", stmts: []string{"DELETE FROM t"}, editable: edit, confirmed: true},
		{name: "DDL 未开放时拒（MySQL 口径）", stmts: []string{"DROP TABLE t"}, editable: edit, confirmed: true,
			wantErr: true, wantDDL: true},
		{name: "DDL 开放：CREATE 直接执行", stmts: []string{"CREATE TABLE t (a int)"}, editable: edit,
			ddlAllowed: true},
		{name: "DDL 开放：DROP 未确认需确认", stmts: []string{"DROP TABLE t"}, editable: edit,
			ddlAllowed: true, wantConf: confirmDanger},
		{name: "DDL 开放：DROP 确认后放行", stmts: []string{"DROP TABLE t"}, editable: edit,
			ddlAllowed: true, confirmed: true},
		{name: "编辑会话危险需确认", stmts: []string{"ATTACH DATABASE 'x' AS y"}, editable: edit,
			wantConf: confirmDanger},
		{name: "编辑会话普通写直接执行", stmts: []string{"UPDATE t SET a=1 WHERE id=1"}, editable: edit},
		{name: "编辑会话未知语句拒（fail closed）", stmts: []string{"FOOBAR t"}, editable: edit, wantErr: true},
		{name: "批量任一条违规整批拒", stmts: []string{"SELECT 1", "UPDATE t SET a=1", "DROP TABLE t"},
			editable: edit, confirmed: true, wantErr: true, wantDDL: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conf, err := checkBatch(tt.stmts, kindSQLite, tt.editable, tt.confirmed, tt.ddlAllowed)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("want error, got confirm=%q err=nil", conf)
				}
				if tt.wantRO && !errors.Is(err, ErrReadOnlySession) {
					t.Fatalf("want ErrReadOnlySession, got %v", err)
				}
				if tt.wantDDL && !strings.Contains(err.Error(), "DDL") {
					t.Fatalf("want DDL 拒绝, got %v", err)
				}
				if tt.wantCtrl && !strings.Contains(err.Error(), "不支持手动事务") {
					t.Fatalf("want 事务控制拒绝, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("want nil err, got %v", err)
			}
			if conf != tt.wantConf {
				t.Fatalf("confirm = %q, want %q", conf, tt.wantConf)
			}
		})
	}
}
