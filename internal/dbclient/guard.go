// guard.go：SQL 安全分类——只读拦截与危险操作检测的单一来源（P0 就埋进查询路径，方案 §5.1）。
//
// 两个口径：
//   - RO 会话：逐条分类，任一条非只读即整批拒（不依赖驱动只读标志；SQLite 另有 mode=ro、
//     MySQL 另有 transaction_read_only=1 作第二道，见 sqlite.go / mysql.go）；
//   - 写放行的会话：DDL 按能力位判定（Capabilities.DDL——SQLite editable 会话开放、MySQL 恒拒）；
//     DROP/TRUNCATE/ATTACH/CALL 等危险语句
//     与缺 WHERE（或 WHERE TRUE / WHERE 1）的 UPDATE/DELETE 走两阶段确认——本包只返回
//     confirm 原因，确认交互在前端（overlay 确认层），重发带 confirmed=true。
//
// 实现是词法级分类，不是完整 SQL 解析器：按方言拆语句 → 跳过字符串/注释/引号标识符 →
// 记录括号深度下的关键字序列，按首关键字 + WITH 体扫描归类。已知盲区（脚本内起 shell 等）
// 由 AGENTS.md 的 wipeguard 与审批链负责，不在这里。未知语句一律按写处理（fail closed）。
package dbclient

import (
	"fmt"
	"strings"
)

// stmtClass 语句类别。
type stmtClass int

const (
	classRead  stmtClass = iota // SELECT / SHOW / EXPLAIN / PRAGMA 查询等
	classWrite                  // INSERT / UPDATE / DELETE / REPLACE / VACUUM / SET…
	classDDL                    // CREATE / ALTER / DROP / TRUNCATE / RENAME…
	classCtrl                   // BEGIN / COMMIT / ROLLBACK / SAVEPOINT（控制台拒，见 checkBatch）
)

// stmtVerdict 单条语句的判定结果。
type stmtVerdict struct {
	class        stmtClass
	danger       bool // 写放行时仍需二次确认（DROP/TRUNCATE/ATTACH/CALL/GRANT/LOAD…）
	missingWhere bool // UPDATE/DELETE 缺 WHERE 或 WHERE TRUE / WHERE 1
	unknown      bool // 首关键字不认识——按写处理
}

// ---------- 词法扫描 ----------

type lexToken struct {
	word  string // 归一化小写的词（仅字母/数字/下划线序列）
	depth int    // 出现时的括号深度
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80
}

// skipQuoted 跳过一个引号段（字符串/引号标识符），返回闭合引号之后的下标。
// 处理成对引号转义（” / "" / “）；MySQL 字符串另支持反斜杠转义。
func skipQuoted(q string, i int, dialect string) int {
	open := q[i]
	closer := open
	if open == '[' {
		closer = ']'
	}
	isMySQL := dialect == kindMySQL
	i++
	for i < len(q) {
		c := q[i]
		// 反斜杠转义必须确认还有下一个字节：尾随单个反斜杠（未闭合字符串）按普通字符
		// 走 i++，否则 i += 2 会越过 len(q)，调用方的 q[i:j] 直接越界 panic
		if isMySQL && c == '\\' && i+1 < len(q) && (open == '\'' || open == '"') {
			i += 2
			continue
		}
		if c == closer {
			if open != '[' && i+1 < len(q) && q[i+1] == closer {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return i
}

func skipLineComment(q string, i int) int {
	for i < len(q) && q[i] != '\n' {
		i++
	}
	if i < len(q) {
		i++ // 含换行
	}
	return i
}

func skipBlockComment(q string, i int) int {
	i += 2
	for i+1 < len(q) && !(q[i] == '*' && q[i+1] == '/') {
		i++
	}
	if i+1 < len(q) {
		return i + 2
	}
	return len(q)
}

// lexTokens 把一条语句切成关键字序列：字符串/注释不产生 token，括号深度记进每个 token。
// '(' 与 ')' 本身不产出 token（深度变化体现在后续词上）。
func lexTokens(stmt, dialect string) []lexToken {
	out := make([]lexToken, 0, 16)
	depth := 0
	isMySQL := dialect == kindMySQL
	i, n := 0, len(stmt)
	for i < n {
		c := stmt[i]
		switch {
		case c == '\'' || c == '"' || c == '`' || (c == '[' && !isMySQL):
			i = skipQuoted(stmt, i, dialect)
		case c == '-' && i+1 < n && stmt[i+1] == '-':
			i = skipLineComment(stmt, i)
		case c == '#' && isMySQL:
			i = skipLineComment(stmt, i)
		case c == '/' && i+1 < n && stmt[i+1] == '*':
			i = skipBlockComment(stmt, i)
		case c == '(':
			depth++
			i++
		case c == ')':
			if depth > 0 {
				depth--
			}
			i++
		case c == ',':
			// 逗号要成词：WITH 的 CTE 列表分隔靠它（多 CTE 其一为数据变更体时逐个体检查）
			out = append(out, lexToken{word: ",", depth: depth})
			i++
		case isWordByte(c):
			start := i
			for i < n && isWordByte(stmt[i]) {
				i++
			}
			out = append(out, lexToken{word: strings.ToLower(stmt[start:i]), depth: depth})
		default:
			i++
		}
	}
	return out
}

// ---------- 语句拆分 ----------

// splitStatements 按顶层分号把查询文本拆成单条语句；字符串/注释里的分号不拆。
// 拆出来的语句已去掉注释（替换为空格保距）并修剪首尾空白，空语句丢弃。
// Redis 走按行拆（一行一条命令，guard_redis.go）。
func splitStatements(q, dialect string) []string {
	if dialect == kindRedis {
		return splitRedisStatements(q)
	}
	var out []string
	var cur strings.Builder
	isMySQL := dialect == kindMySQL
	flush := func() {
		s := strings.TrimSpace(cur.String())
		cur.Reset()
		if s != "" {
			out = append(out, s)
		}
	}
	i, n := 0, len(q)
	for i < n {
		c := q[i]
		switch {
		case c == '\'' || c == '"' || c == '`' || (c == '[' && !isMySQL):
			j := skipQuoted(q, i, dialect)
			cur.WriteString(q[i:j])
			i = j
		case c == '-' && i+1 < n && q[i+1] == '-' && (isMySQLLineComment(q, i) || !isMySQL):
			i = skipLineComment(q, i)
			cur.WriteByte(' ')
		case c == '#' && isMySQL:
			i = skipLineComment(q, i)
			cur.WriteByte(' ')
		case c == '/' && i+1 < n && q[i+1] == '*':
			i = skipBlockComment(q, i)
			cur.WriteByte(' ')
		case c == ';':
			flush()
			i++
		default:
			cur.WriteByte(c)
			i++
		}
	}
	flush()
	return out
}

// isMySQLLineComment MySQL 的 `--` 注释要求第二个杠后跟空白（`a--b` 是双目减号）。
func isMySQLLineComment(q string, i int) bool {
	i += 2
	if i >= len(q) {
		return true // 行尾
	}
	return q[i] == ' ' || q[i] == '\t' || q[i] == '\n' || q[i] == '\r'
}

// ---------- 分类 ----------

var (
	// pragmaWriteNames 无参数也产生写动作的 PRAGMA（推进 WAL / 收缩空间）。
	pragmaWriteNames = map[string]bool{"wal_checkpoint": true, "checkpoint": true, "incremental_vacuum": true}
	// pragmaReadNames 无参数查询类 PRAGMA 白名单——PRAGMA 的分类走白名单反向收口：
	// 引号名 / 库限定名会让词法识别漏判（`PRAGMA "journal_mode" = WAL` 只剩 [pragma, wal]），
	// 名字不在白名单里一律按写处理（fail closed），SQLite mode=ro 是第二道。
	pragmaReadNames = map[string]bool{
		"table_info": true, "table_xinfo": true, "index_list": true, "index_info": true,
		"index_xinfo": true, "foreign_key_list": true, "foreign_key_check": true,
		"compile_options": true, "function_list": true, "module_list": true,
		"pragma_list": true, "journal_mode": true, "page_size": true, "encoding": true,
		"user_version": true, "data_version": true, "schema_version": true,
		"quick_check": true, "integrity_check": true, "max_page_count": true,
	}
	// dangerVerbs 写放行会话里仍需二次确认的首关键字。
	dangerVerbs = map[string]bool{
		"attach": true, "detach": true, "call": true, "grant": true, "revoke": true,
		"flush": true, "kill": true, "shutdown": true, "reset": true, "load": true,
		"do": true, "handler": true, "prepare": true, "execute": true, "deallocate": true,
		"xa": true, "signal": true, "resignal": true, "get": true,
	}
)

// classifyStatement 归类单条语句。只认语句位置的第一个关键字（AGENTS.md 的命令判定同口径）。
// Redis 命令走独立词表（guard_redis.go）——首词 + 白名单 + fail closed 与这里同一套模型。
func classifyStatement(stmt, dialect string) stmtVerdict {
	if dialect == kindRedis {
		return classifyRedisStatement(stmt)
	}
	toks := lexTokens(stmt, dialect)
	if len(toks) == 0 {
		return stmtVerdict{class: classWrite, unknown: true}
	}
	if toks[0].depth != 0 {
		return stmtVerdict{class: classWrite, unknown: true} // 括号开头：非法或伪装，fail closed
	}
	head := toks[0].word
	if head == "with" {
		return classifyWith(toks)
	}
	switch head {
	case "select", "values", "table", "explain", "describe", "desc", "show":
		v := stmtVerdict{class: classRead}
		// EXPLAIN ANALYZE 会真实执行语句（MySQL 8.0.19+ 支持 DML、SQLite 3.29+ 同名语法），
		// 按首关键字归 read 会放行真实写——explain 后跟 analyze 一律按写处理，
		// 缺 WHERE 判定沿用被包裹的语句（顶层 where 扫描跳过 analyze 关键字即可命中）
		if head == "explain" && len(toks) > 1 && toks[1].depth == 0 && toks[1].word == "analyze" {
			v.class = classWrite
			v.missingWhere = lacksWhereFrom(toks, 0)
		}
		if dialect == kindMySQL && head == "select" {
			// SELECT ... INTO OUTFILE/DUMPFILE 写服务端文件；SELECT ... INTO @var 写变量，
			// 一律按写处理（OUTFILE/DUMPFILE 额外标危险）。
			for k := 1; k < len(toks); k++ {
				if toks[k].depth == 0 && toks[k].word == "into" {
					v.class = classWrite
					if k+1 < len(toks) && (toks[k+1].word == "outfile" || toks[k+1].word == "dumpfile") {
						v.danger = true
					}
					break
				}
			}
		}
		return v
	case "insert", "replace":
		return stmtVerdict{class: classWrite}
	case "update", "delete":
		v := stmtVerdict{class: classWrite}
		v.missingWhere = lacksWhere(toks)
		return v
	case "create", "alter", "rename", "truncate", "drop":
		v := stmtVerdict{class: classDDL}
		if head == "drop" || head == "truncate" {
			v.danger = true
		}
		return v
	case "vacuum", "analyze", "reindex":
		v := stmtVerdict{class: classWrite}
		if head == "vacuum" {
			for k := 1; k < len(toks); k++ {
				if toks[k].depth == 0 && toks[k].word == "into" {
					v.danger = true // VACUUM INTO 写到语句里指定的文件
					break
				}
			}
		}
		return v
	case "attach", "detach":
		return stmtVerdict{class: classWrite, danger: true} // 跨库挂载可写到会话之外
	case "pragma":
		return classifyPragma(toks)
	case "begin", "start", "commit", "rollback", "savepoint", "release":
		return stmtVerdict{class: classCtrl}
	case "set", "use", "lock", "unlock":
		// SET 能改 session 变量（含 transaction_read_only 自解），USE 切库，LOCK 占锁。
		return stmtVerdict{class: classWrite}
	default:
		if dangerVerbs[head] {
			return stmtVerdict{class: classWrite, danger: true}
		}
		return stmtVerdict{class: classWrite, unknown: true}
	}
}

// classifyWith 处理 WITH [RECURSIVE] name [(cols)] AS ( body ) [, …] 主语句。
// SQLite 3.35+ 支持数据变更 CTE（WITH x AS (DELETE … RETURNING …) SELECT …），
// 按首关键字分类会把 WITH 开头的写语句误判成读——逐个体检查体首关键字与体级 WHERE。
func classifyWith(toks []lexToken) stmtVerdict {
	i := 1
	if i < len(toks) && toks[i].word == "recursive" {
		i++
	}
	dmlBody := false
	missingWhere := false
	for {
		if i >= len(toks) || toks[i].depth != 0 {
			return stmtVerdict{class: classWrite, unknown: true}
		}
		i++ // CTE 名
		// 可选列定义括号：前进到 depth0 的 AS
		for i < len(toks) {
			if toks[i].depth == 0 {
				break
			}
			i++
		}
		if i >= len(toks) || toks[i].word != "as" {
			return stmtVerdict{class: classWrite, unknown: true}
		}
		i++
		// 可选的 MATERIALIZED / NOT MATERIALIZED 标记（SQLite 3.35+ / PG 方言），容忍后再找体
		if i < len(toks) && toks[i].depth == 0 && toks[i].word == "not" {
			i++
		}
		if i < len(toks) && toks[i].depth == 0 && toks[i].word == "materialized" {
			i++
		}
		if i >= len(toks) || toks[i].depth < 1 {
			return stmtVerdict{class: classWrite, unknown: true} // 缺体括号
		}
		first := toks[i].word
		if first == "insert" || first == "update" || first == "delete" || first == "with" {
			dmlBody = true
		}
		bodyWrite := first == "update" || first == "delete"
		bodyWhere := false
		for i < len(toks) && toks[i].depth >= 1 {
			if bodyWrite && toks[i].depth == 1 && toks[i].word == "where" {
				bodyWhere = true
			}
			i++
		}
		if bodyWrite && !bodyWhere {
			missingWhere = true
		}
		if i >= len(toks) {
			return stmtVerdict{class: classWrite, unknown: true} // 括号不闭合
		}
		// 此刻 toks[i] 是回到 depth0 的第一个词：逗号 → 下一个 CTE；否则是主语句动词
		if toks[i].word == "," && i+1 < len(toks) {
			i++
			continue
		}
		switch toks[i].word {
		case "select", "values", "table":
			if dmlBody {
				return stmtVerdict{class: classWrite, missingWhere: missingWhere}
			}
			return stmtVerdict{class: classRead}
		case "insert", "replace", "update", "delete":
			v := stmtVerdict{class: classWrite, missingWhere: missingWhere}
			if toks[i].word == "update" || toks[i].word == "delete" {
				v.missingWhere = v.missingWhere || lacksWhereFrom(toks, i)
			}
			return v
		default:
			return stmtVerdict{class: classWrite, unknown: true}
		}
	}
}

// classifyPragma PRAGMA 分类走白名单：白名单内的无参查询是读；赋值/带值/白名单外的名字
// （含引号名、库限定名——词法层识别不了，宁可错杀）一律按写。
func classifyPragma(toks []lexToken) stmtVerdict {
	if len(toks) < 2 {
		return stmtVerdict{class: classWrite, unknown: true}
	}
	name := toks[1].word
	if pragmaWriteNames[name] {
		return stmtVerdict{class: classWrite}
	}
	// 有 depth0 的后续词（赋值右侧/限定名）→ 写
	for k := 2; k < len(toks); k++ {
		if toks[k].depth == 0 {
			return stmtVerdict{class: classWrite}
		}
	}
	if pragmaReadNames[name] {
		return stmtVerdict{class: classRead}
	}
	return stmtVerdict{class: classWrite}
}

// lacksWhere 判断 UPDATE/DELETE 是否缺 WHERE（或 WHERE 恒真）。
// 只认 depth0 的 WHERE——子查询里的 WHERE 不算数。
func lacksWhere(toks []lexToken) bool {
	return lacksWhereFrom(toks, 0)
}

func lacksWhereFrom(toks []lexToken, start int) bool {
	for k := start + 1; k < len(toks); k++ {
		if toks[k].depth != 0 || toks[k].word != "where" {
			continue
		}
		// WHERE 恒真检测：WHERE TRUE / WHERE 1 / WHERE 1=1（'=' 不成词，剩 [1,1]）。
		rest := make([]string, 0, len(toks)-k-1)
		for j := k + 1; j < len(toks); j++ {
			if toks[j].depth == 0 {
				rest = append(rest, toks[j].word)
			}
		}
		switch {
		case len(rest) == 1 && (rest[0] == "true" || rest[0] == "1"):
			return true
		case len(rest) == 0:
			// WHERE 后面只剩被丢弃的引号串/运算符（`WHERE 'a'='a'`）：无法证明有过滤条件，
			// 按恒真处理，进确认流程。
			return true
		case len(rest) == 2 && rest[0] == rest[1] && tautologyOperand(rest[0]):
			// 0=0 / 2>1 左侧同形 / 'a'='a'：字面量自比恒真。
			// 列自比（col = col）不在此列——rest 里是标识符，不算字面量。
			return true
		}
		return false
	}
	return true // 顶层没有 WHERE
}

// tautologyOperand 判断 WHERE 两侧的同一 token 是否字面量（数字或引号串）。
// 运营商筛掉后 rest 只剩词，`0 = 0` 与 `2 > 1` 都会落到"两个相同的数字"上。
func tautologyOperand(word string) bool {
	if word == "" {
		return false
	}
	if word[0] == '\'' || word[0] == '"' {
		return true
	}
	for _, r := range word {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ---------- 批量口径 ----------

// confirmNeedReason 需要二次确认时的原因值（返回给前端）。
const (
	confirmDanger       = "danger"
	confirmMissingWhere = "missingWhere"
)

// checkBatch 对整批语句做判定（方案口径：逐条分类，任一条非只读即整批拒）。
// 返回值：
//   - err != nil：直接拒绝（RO 拒写 / DDL 拒 / 未知语句拒 / 事务控制语句拒）；
//   - confirm == "" 且 err == nil：放行执行；
//   - confirm != nil：需要前端确认后带 confirmed=true 重发。
//
// 事务控制（BEGIN/COMMIT/SAVEPOINT）在控制台**拒绝**而不是放行：连接池逐条执行没有
// 会话级事务绑定（MySQL 池 2 连接下 BEGIN 与后续语句可能落不同连接，COMMIT 落空即静默丢写；
// SQLite 单连接残留 BEGIN 会让批量编辑的 BeginTx 报事务嵌套）。标签页编辑的事务由
// ApplyChanges 的单事务机制统一管理，不需要用户手写。
func checkBatch(stmts []string, dialect string, editable, confirmed, ddlAllowed bool) (confirm string, err error) {
	for _, stmt := range stmts {
		v := classifyStatement(stmt, dialect)
		switch v.class {
		case classCtrl:
			return "", fmt.Errorf("控制台不支持手动事务（BEGIN/COMMIT/SAVEPOINT）：批量编辑的事务由「预览并提交」自动管理，请去掉事务控制语句：%s", snippet(stmt))
		case classRead:
			continue
		}
		if !editable {
			return "", fmt.Errorf("%w：%s", ErrReadOnlySession, snippet(stmt))
		}
		if v.unknown {
			return "", fmt.Errorf("无法识别的语句（按写拒绝，fail closed）：%s", snippet(stmt))
		}
		if v.class == classDDL {
			if !ddlAllowed {
				return "", fmt.Errorf("结构变更（DDL）未开放：%s", snippet(stmt))
			}
			if v.danger && !confirmed {
				return confirmDanger, nil
			}
			continue
		}
		// classWrite
		if v.danger && !confirmed {
			return confirmDanger, nil
		}
		if v.missingWhere && !confirmed {
			return confirmMissingWhere, nil
		}
	}
	return "", nil
}

func snippet(stmt string) string {
	s := strings.TrimSpace(strings.Join(strings.Fields(stmt), " "))
	if len(s) > 80 {
		return s[:80] + "…"
	}
	return s
}
