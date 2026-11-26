package dbclient

// query.go：查询执行（控制台 + 表浏览下推）与结果组装。
//
// 控制台口径：guard 拆分 + 逐条分类 → RO 整批拒 / 写放行会话的 DDL 按能力位（SQLite editable 开放）、危险与缺 WHERE
// 两阶段确认 → 逐条执行，返回最后一条 SELECT 的结果集（写语句以「N 行受影响」进 Message）。
// 表浏览口径：排序/筛选/分页全部下推（方案 §5.1 决策），列名经元数据校验、值走占位符。

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"datalens/internal/sqlview"
)

// Query 执行控制台查询。queryID 由前端生成，用于 DBCancel 取消执行中的慢查询。
// confirmed=false 时危险/缺 WHERE 语句返回 Status=confirm，前端确认后重发。
func Query(id, queryID, q string, confirmed bool, limit int) (QueryOutcome, error) {
	s, err := getSession(id)
	if err != nil {
		return QueryOutcome{}, err
	}
	q = strings.TrimSpace(q)
	if q == "" {
		return QueryOutcome{}, errors.New(queryEmptyText(s.kind))
	}
	limit = clampRowLimit(limit)
	stmts := splitStatements(q, s.kind)
	if len(stmts) == 0 {
		return QueryOutcome{}, errors.New(queryEmptyText(s.kind))
	}
	confirm, err := checkBatch(stmts, s.kind, s.editable, confirmed, s.caps.DDL)
	if err != nil {
		return QueryOutcome{}, err
	}
	if confirm != "" {
		return QueryOutcome{
			Status:  "confirm",
			Confirm: confirm,
			Message: confirmMessage(confirm, s.kind),
		}, nil
	}

	out := QueryOutcome{Status: "ok", Result: sqlview.SQLResult{}}
	started := time.Now()
	for _, stmt := range stmts {
		res, wrote, err := executeStatement(s, queryID, stmt, limit)
		if err != nil {
			return QueryOutcome{}, fmt.Errorf("%s：%w", snippet(stmt), err)
		}
		out.Statements++
		if wrote {
			out.Writes++
		}
		out.Result = res
		// 逐条留档（前端按语句分结果 tab；每条 SQL 截断防巨型 payload）
		out.Results = append(out.Results, StatementResult{SQL: snippet(stmt), Result: res, Wrote: wrote})
	}
	out.Result.ElapsedMs = time.Since(started).Milliseconds()
	return out, nil
}

func confirmMessage(reason, kind string) string {
	if reason == confirmDanger {
		if kind == kindRedis {
			return "这条命令被判定为危险操作（FLUSHALL/CONFIG SET/SHUTDOWN/DEBUG 等），确认后才会执行。"
		}
		return "这条语句被判定为危险操作（DROP/TRUNCATE/ATTACH/CALL 等），确认后才会执行。"
	}
	return "UPDATE/DELETE 缺少 WHERE（或 WHERE 恒真），将作用于全表；确认后才会执行。"
}

// queryEmptyText 空输入的报错文案按方言区分。
func queryEmptyText(kind string) string {
	if kind == kindRedis {
		return "命令不能为空（每行一条 Redis 命令）"
	}
	return "SQL 不能为空"
}

// executeStatement 单条语句执行；wrote 表示是写语句（前端据此记操作留痕）。
func executeStatement(s *dbSession, queryID, stmt string, limit int) (res sqlview.SQLResult, wrote bool, err error) {
	v := classifyStatement(stmt, s.kind)
	if s.kind == kindRedis {
		return executeRedisStatement(s, queryID, stmt, v, limit)
	}
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	s.registerQuery(queryID, cancel)
	defer s.unregisterQuery(queryID)

	if v.class == classRead {
		rows, err := s.db.QueryContext(ctx, stmt)
		if err != nil {
			return sqlview.SQLResult{}, false, err
		}
		defer rows.Close()
		out, err := resultFromRows(rows, limit)
		return out, false, err
	}
	exec, err := s.db.ExecContext(ctx, stmt)
	if err != nil {
		return sqlview.SQLResult{}, v.class != classCtrl, err
	}
	affected, _ := exec.RowsAffected()
	msg := "已执行"
	if v.class != classCtrl {
		msg = fmt.Sprintf("已执行，%d 行受影响", affected)
	}
	return sqlview.SQLResult{Message: msg}, v.class != classCtrl, nil
}

// resultFromRows 组装结果集：读 limit+1 行判截断（与 sqlview 的 Truncated 口径一致）。
func resultFromRows(rows *sql.Rows, limit int) (sqlview.SQLResult, error) {
	cols, err := rows.Columns()
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	out := sqlview.SQLResult{Columns: cols}
	if len(cols) == 0 {
		out.Message = "已执行"
		return out, nil
	}
	for rows.Next() {
		if len(out.Rows) >= limit {
			out.Truncated = true
			break
		}
		scan := make([]any, len(cols))
		for i := range scan {
			scan[i] = new(any)
		}
		if err := rows.Scan(scan...); err != nil {
			return sqlview.SQLResult{}, err
		}
		row := make([]string, len(cols))
		nulls := make([]bool, len(cols))
		for i := range scan {
			row[i], nulls[i] = formatCell(*(scan[i].(*any)))
		}
		out.Rows = append(out.Rows, row)
		out.Nulls = append(out.Nulls, nulls)
	}
	if err := rows.Err(); err != nil {
		return sqlview.SQLResult{}, err
	}
	return out, nil
}

// ---------- 表浏览（下推） ----------

// Browse 表数据浏览：ORDER BY / WHERE / LIMIT 全部下推。
func Browse(id string, req BrowseRequest) (sqlview.SQLResult, error) {
	s, err := getSession(id)
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	meta, err := describeMeta(s, req.Database, req.Table, false)
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	stmt, args, err := buildBrowseSQL(s.kind, meta, req)
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	queryID := strings.TrimSpace(req.QueryID)
	if queryID == "" {
		queryID = nextOperationID("browse")
	}
	s.registerQuery(queryID, cancel)
	defer s.unregisterQuery(queryID)
	rows, err := s.db.QueryContext(ctx, stmt, args...)
	if err != nil {
		return sqlview.SQLResult{}, err
	}
	defer rows.Close()
	// SQL 里 LIMIT 是 limit+1（服务端多取一行），结果组装按真实 limit 截断并打 Truncated
	return resultFromRows(rows, clampRowLimit(req.Limit))
}

// buildBrowseSQL 生成下推 SQL；列名全部对照元数据白名单，值全部走占位符。
// LIMIT 取 limit+1：截断判定靠「多取的一行」——LIMIT 在服务端截掉后客户端永远看不到
// 第 limit+1 行，少取一行就会永远标不出 Truncated。
func buildBrowseSQL(kind string, meta *DBTableMeta, req BrowseRequest) (string, []any, error) {
	var b strings.Builder
	b.WriteString("SELECT * FROM ")
	b.WriteString(quoteTableRef(kind, meta.Database, meta.Table))
	var args []any
	where, wargs, err := buildWhere(kind, meta, req.Filters)
	if err != nil {
		return "", nil, err
	}
	if where != "" {
		b.WriteString(" WHERE ")
		b.WriteString(where)
		args = append(args, wargs...)
	}
	if len(req.OrderCols) > 0 {
		// 多列 ORDER BY（结构化面板）：逐列过元数据白名单 + quoteIdent，不接受原始 SQL 片段
		parts := make([]string, 0, len(req.OrderCols))
		for _, oc := range req.OrderCols {
			col, err := resolveColumn(meta, oc.Column)
			if err != nil {
				return "", nil, err
			}
			dir := "ASC"
			if oc.Desc {
				dir = "DESC"
			}
			parts = append(parts, quoteIdent(kind, col)+" "+dir)
		}
		b.WriteString(" ORDER BY ")
		b.WriteString(strings.Join(parts, ", "))
	} else if req.SortColumn != "" {
		col, err := resolveColumn(meta, req.SortColumn)
		if err != nil {
			return "", nil, err
		}
		dir := "ASC"
		if req.SortDesc {
			dir = "DESC"
		}
		b.WriteString(" ORDER BY ")
		b.WriteString(quoteIdent(kind, col))
		b.WriteString(" ")
		b.WriteString(dir)
	}
	b.WriteString(" LIMIT ? OFFSET ?")
	args = append(args, clampRowLimit(req.Limit)+1, maxInt(req.Offset, 0))
	return b.String(), args, nil
}

// buildWhere 结构化筛选 → 参数化 WHERE（AND 连接；值永远是占位符参数）。
func buildWhere(kind string, meta *DBTableMeta, filters []FilterCond) (string, []any, error) {
	if len(filters) == 0 {
		return "", nil, nil
	}
	var parts []string
	var args []any
	for _, f := range filters {
		col, err := resolveColumn(meta, f.Column)
		if err != nil {
			return "", nil, err
		}
		ref := quoteIdent(kind, col)
		switch f.Op {
		case "eq":
			parts = append(parts, ref+" = ?")
			args = append(args, f.Value)
		case "ne":
			parts = append(parts, ref+" <> ?")
			args = append(args, f.Value)
		case "lt":
			parts = append(parts, ref+" < ?")
			args = append(args, f.Value)
		case "le":
			parts = append(parts, ref+" <= ?")
			args = append(args, f.Value)
		case "gt":
			parts = append(parts, ref+" > ?")
			args = append(args, f.Value)
		case "ge":
			parts = append(parts, ref+" >= ?")
			args = append(args, f.Value)
		case "contains":
			// 用户值里的 LIKE 通配符转义，语义就是「包含原文」。
			// 转义符用 '!'：反斜杠在 MySQL 字符串字面量里有特殊语义（'\' 会吞掉收尾引号）。
			escaped := strings.NewReplacer(`!`, `!!`, `%`, `!%`, `_`, `!_`).Replace(f.Value)
			parts = append(parts, ref+" LIKE ? ESCAPE '!'")
			args = append(args, "%"+escaped+"%")
		case "null":
			parts = append(parts, ref+" IS NULL")
		case "notNull":
			parts = append(parts, ref+" IS NOT NULL")
		default:
			return "", nil, fmt.Errorf("不支持的筛选方式：%q", f.Op)
		}
	}
	return strings.Join(parts, " AND "), args, nil
}

// resolveColumn 对照元数据白名单解析列名（大小写不敏感，返回元数据里的原样名）。
func resolveColumn(meta *DBTableMeta, name string) (string, error) {
	for _, c := range meta.Columns {
		if strings.EqualFold(c.Name, name) {
			return c.Name, nil
		}
	}
	return "", fmt.Errorf("列不存在：%q（表 %s）", name, meta.Table)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
