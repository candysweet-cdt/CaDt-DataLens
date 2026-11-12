package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// 大文件只读 SQL：把 CSV/TSV/JSONL 导入临时 SQLite，查询只作用于临时副本。
const (
	maxSQLFileBytes    = 100 << 20
	sqlImportRowLimit  = 500000
	sqlImportColLimit  = 2000
	sqlImportKeyLimit  = 500
	sqlQueryTimeout    = 20 * time.Second
	sqlQueryRowDefault = 500
	sqlQueryRowMax     = 5000
)

type SQLImportInfo struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Rows      int      `json:"rows"`
	Columns   []string `json:"columns"`
	Bytes     int64    `json:"bytes"`
	ElapsedMs int64    `json:"elapsedMs"`
	Truncated bool     `json:"truncated"`
}

type SQLResult struct {
	Columns   []string   `json:"columns"`
	Rows      [][]string `json:"rows"`
	Nulls     [][]bool   `json:"nulls"`
	Truncated bool       `json:"truncated"`
	ElapsedMs int64      `json:"elapsedMs"`
	Message   string     `json:"message"`
}

type sqlColumn struct {
	Name string
	Type string
}

type sqlSession struct {
	db     *sql.DB
	path   string
	info   SQLImportInfo
	closed bool
}

var (
	sqlSessionsMu sync.Mutex
	sqlSessions   = make(map[string]*sqlSession)
	sqlSessionSeq int64
)

func nextSQLSessionID() string {
	sqlSessionsMu.Lock()
	defer sqlSessionsMu.Unlock()
	sqlSessionSeq++
	return fmt.Sprintf("sql-%d-%d", time.Now().UnixNano(), sqlSessionSeq)
}

func quoteSQLIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// sqlWritesOutsideSession 拦截会把数据写到临时副本之外文件的语句（ATTACH / DETACH / VACUUM）。
// 临时副本上的 INSERT/UPDATE/DELETE 本来就允许（SQL 视图是可编辑的临时副本，见 TestSQLDML）。
var sqlExternalWriteRe = regexp.MustCompile(`(?i)\b(?:attach|detach|vacuum)\b`)

// stripSQLLiterals 去掉注释与字符串字面量，避免 `SELECT 'ATTACH'` 之类的误判。
func stripSQLLiterals(q string) string {
	var b strings.Builder
	b.Grow(len(q))
	for i := 0; i < len(q); i++ {
		c := q[i]
		switch {
		case c == '-' && i+1 < len(q) && q[i+1] == '-':
			for i < len(q) && q[i] != '\n' {
				i++
			}
			b.WriteByte('\n')
		case c == '/' && i+1 < len(q) && q[i+1] == '*':
			i += 2
			for i+1 < len(q) && !(q[i] == '*' && q[i+1] == '/') {
				i++
			}
			i++
			b.WriteByte(' ')
		case c == '\'' || c == '"' || c == '`' || c == '[':
			closer := c
			if c == '[' {
				closer = ']'
			}
			i++
			for i < len(q) {
				if q[i] == closer {
					if i+1 < len(q) && q[i+1] == closer && closer != ']' {
						i += 2
						continue
					}
					break
				}
				i++
			}
			b.WriteByte(' ')
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func sqlWritesOutsideSession(q string) bool {
	return sqlExternalWriteRe.MatchString(stripSQLLiterals(q))
}

func createSQLTempDB() (*sqlSession, error) {
	f, err := os.CreateTemp("", "cadt-sql-*.db")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	db.SetMaxOpenConns(1)
	// 临时副本：关掉 journal/sync 换取导入速度；掉电/崩溃直接重新导入即可。
	for _, pragma := range []string{"PRAGMA journal_mode=OFF", "PRAGMA synchronous=OFF", "PRAGMA temp_store=MEMORY"} {
		_, _ = db.Exec(pragma)
	}
	return &sqlSession{db: db, path: path}, nil
}

func (s *sqlSession) dispose() {
	if s == nil || s.closed {
		return
	}
	s.closed = true
	_ = s.db.Close()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(s.path + suffix)
	}
}

func (s *sqlSession) createTable(columns []sqlColumn) error {
	defs := make([]string, len(columns))
	for i, col := range columns {
		defs[i] = quoteSQLIdent(col.Name) + " " + col.Type
	}
	_, err := s.db.Exec("CREATE TABLE t (" + strings.Join(defs, ", ") + ")")
	return err
}

func (s *sqlSession) insertRows(columnCount int, rows func(insert func([]any) error) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	placeholders := make([]string, columnCount)
	for i := range placeholders {
		placeholders[i] = "?"
	}
	stmt, err := tx.Prepare("INSERT INTO t VALUES (" + strings.Join(placeholders, ",") + ")")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := rows(func(values []any) error {
		_, err := stmt.Exec(values...)
		return err
	}); err != nil {
		stmt.Close()
		_ = tx.Rollback()
		return err
	}
	stmt.Close()
	return tx.Commit()
}

func loadSQLSource(path, encoding, text string, useText bool) (string, int64, error) {
	if useText {
		if int64(len(text)) > maxSQLFileBytes {
			return "", 0, fmt.Errorf("内容超过 %d MB，无法导入", maxSQLFileBytes/(1<<20))
		}
		return strings.TrimPrefix(text, "\ufeff"), int64(len(text)), nil
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "", 0, errors.New("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	if info.IsDir() {
		return "", 0, errors.New("不能查询文件夹")
	}
	if info.Size() > maxSQLFileBytes {
		return "", 0, fmt.Errorf("文件超过 %d MB，无法导入", maxSQLFileBytes/(1<<20))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	if len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
		raw = raw[3:]
	}
	decoded, _, err := decodeBytes(raw, encoding)
	if err != nil {
		return "", 0, err
	}
	return decoded, info.Size(), nil
}

func csvDelimiter(content, kind string) rune {
	if kind == "tsv" {
		return '\t'
	}
	firstLine := content
	if i := strings.IndexAny(firstLine, "\r\n"); i >= 0 {
		firstLine = firstLine[:i]
	}
	if strings.Count(firstLine, "\t") > strings.Count(firstLine, ",") {
		return '\t'
	}
	if strings.Count(firstLine, ";") > strings.Count(firstLine, ",") && strings.Count(firstLine, ";") > strings.Count(firstLine, "\t") {
		return ';'
	}
	return ','
}

// importCSV 两遍解析：先统计列/类型，再写入；不在内存里保存全部行。
func importCSV(content string, delimiter rune) ([]sqlColumn, func(insert func([]any) error) error, int, bool, error) {
	newReader := func() *csv.Reader {
		reader := csv.NewReader(strings.NewReader(content))
		reader.Comma = delimiter
		reader.FieldsPerRecord = -1
		reader.LazyQuotes = true
		return reader
	}
	first, err := newReader().Read()
	if err == io.EOF {
		return nil, nil, 0, false, errors.New("文件为空")
	}
	if err != nil {
		return nil, nil, 0, false, err
	}
	maxCols := len(first)
	allInt := make([]bool, 0)
	allReal := make([]bool, 0)
	hasValue := make([]bool, 0)
	ensure := func(n int) {
		for len(allInt) < n {
			allInt = append(allInt, true)
			allReal = append(allReal, true)
			hasValue = append(hasValue, false)
		}
	}
	ensure(maxCols)
	rows := 0
	truncated := false
	reader := newReader()
	if _, err := reader.Read(); err != nil {
		return nil, nil, 0, false, err
	}
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, 0, false, err
		}
		if rows >= sqlImportRowLimit {
			truncated = true
			break
		}
		rows++
		if len(record) > maxCols {
			maxCols = len(record)
			if maxCols > sqlImportColLimit {
				return nil, nil, 0, false, fmt.Errorf("列数超过 %d", sqlImportColLimit)
			}
		}
		ensure(len(record))
		for i, value := range record {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			hasValue[i] = true
			// 只有能原样往返的数字才推断为数值列；"00123"/"30.0"/"+1" 保持 TEXT，避免查询视图改写原始格式。
			if n, err := strconv.ParseInt(value, 10, 64); err != nil || strconv.FormatInt(n, 10) != value {
				allInt[i] = false
			}
			if f, err := strconv.ParseFloat(value, 64); err != nil || strconv.FormatFloat(f, 'g', -1, 64) != value {
				allReal[i] = false
			}
		}
	}
	columns := make([]sqlColumn, maxCols)
	for i := 0; i < maxCols; i++ {
		name := ""
		if i < len(first) {
			name = strings.TrimSpace(first[i])
		}
		if name == "" {
			name = "col" + strconv.Itoa(i+1)
		}
		typ := "TEXT"
		if i < len(hasValue) && hasValue[i] {
			if allInt[i] {
				typ = "INTEGER"
			} else if allReal[i] {
				typ = "REAL"
			}
		}
		columns[i] = sqlColumn{Name: uniqueColumnName(columns, name), Type: typ}
	}
	insertRows := func(insert func([]any) error) error {
		reader := newReader()
		if _, err := reader.Read(); err != nil {
			return err
		}
		count := 0
		for {
			record, err := reader.Read()
			if err == io.EOF || count >= rows {
				return nil
			}
			if err != nil {
				return err
			}
			values := make([]any, maxCols)
			for i := 0; i < maxCols; i++ {
				value := ""
				if i < len(record) {
					value = strings.TrimSpace(record[i])
				}
				if value == "" && columns[i].Type != "TEXT" {
					values[i] = nil
				} else {
					values[i] = value
				}
			}
			if err := insert(values); err != nil {
				return err
			}
			count++
		}
	}
	return columns, insertRows, rows, truncated, nil
}

func uniqueColumnName(existing []sqlColumn, name string) string {
	used := make(map[string]bool, len(existing))
	for _, col := range existing {
		used[strings.ToLower(col.Name)] = true
	}
	if !used[strings.ToLower(name)] {
		return name
	}
	for i := 2; ; i++ {
		candidate := name + "_" + strconv.Itoa(i)
		if !used[strings.ToLower(candidate)] {
			return candidate
		}
	}
}

// importJSONL 第一遍收集顶层键与类型，第二遍写入；非对象行整体退化为单列 data。
func importJSONL(content string) ([]sqlColumn, func(insert func([]any) error) error, int, bool, error) {
	lines := strings.Split(content, "\n")
	type columnState struct {
		allInt  bool
		allReal bool
		has     bool
	}
	keys := make([]string, 0)
	states := make(map[string]*columnState)
	rows := 0
	truncated := false
	fallback := false
	for _, line := range lines {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" {
			continue
		}
		if rows >= sqlImportRowLimit {
			truncated = true
			break
		}
		rows++
		var object map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &object); err != nil {
			fallback = true
			continue
		}
		for key, rawValue := range object {
			if _, ok := states[key]; !ok {
				if len(keys) >= sqlImportKeyLimit {
					fallback = true
					break
				}
				keys = append(keys, key)
				states[key] = &columnState{allInt: true, allReal: true}
			}
			state := states[key]
			var value any
			decoder := json.NewDecoder(strings.NewReader(string(rawValue)))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil || value == nil {
				continue
			}
			state.has = true
			switch v := value.(type) {
			case json.Number:
				text := v.String()
				if strings.ContainsAny(text, ".eE") {
					state.allInt = false
				} else if _, err := strconv.ParseInt(text, 10, 64); err != nil {
					state.allInt = false
					state.allReal = false
				}
			default:
				state.allInt = false
				state.allReal = false
			}
		}
		if fallback {
			break
		}
	}
	if fallback || len(keys) == 0 {
		// 第一遍可能在出错行提前 break，这里重新统计总行数（含截断标记）。
		rows = 0
		truncated = false
		for _, line := range lines {
			line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			if line == "" {
				continue
			}
			if rows >= sqlImportRowLimit {
				truncated = true
				break
			}
			rows++
		}
		columns := []sqlColumn{{Name: "data", Type: "TEXT"}}
		insertRows := func(insert func([]any) error) error {
			count := 0
			for _, line := range lines {
				line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
				if line == "" {
					continue
				}
				if count >= rows {
					break
				}
				if err := insert([]any{line}); err != nil {
					return err
				}
				count++
			}
			return nil
		}
		return columns, insertRows, rows, truncated, nil
	}
	columns := make([]sqlColumn, len(keys))
	for i, key := range keys {
		state := states[key]
		typ := "TEXT"
		if state.has {
			if state.allInt {
				typ = "INTEGER"
			} else if state.allReal {
				typ = "REAL"
			}
		}
		name := key
		if name == "" {
			name = "col" + strconv.Itoa(i+1)
		}
		columns[i] = sqlColumn{Name: uniqueColumnName(columns, name), Type: typ}
	}
	insertRows := func(insert func([]any) error) error {
		count := 0
		for _, line := range lines {
			line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			if line == "" {
				continue
			}
			if count >= rows {
				break
			}
			var object map[string]json.RawMessage
			if err := json.Unmarshal([]byte(line), &object); err != nil {
				return err
			}
			values := make([]any, len(keys))
			for i, key := range keys {
				rawValue, ok := object[key]
				if !ok || string(rawValue) == "null" {
					values[i] = nil
					continue
				}
				var value any
				decoder := json.NewDecoder(strings.NewReader(string(rawValue)))
				decoder.UseNumber()
				if err := decoder.Decode(&value); err != nil {
					values[i] = string(rawValue)
					continue
				}
				switch v := value.(type) {
				case string:
					values[i] = v
				case json.Number:
					values[i] = v.String()
				case bool:
					if columns[i].Type == "INTEGER" || columns[i].Type == "REAL" {
						if v {
							values[i] = 1
						} else {
							values[i] = 0
						}
					} else {
						values[i] = strconv.FormatBool(v)
					}
				default:
					encoded, _ := json.Marshal(v)
					values[i] = string(encoded)
				}
			}
			if err := insert(values); err != nil {
				return err
			}
			count++
		}
		return nil
	}
	return columns, insertRows, rows, truncated, nil
}

func (a *App) SQLImport(path, kind, encoding, text string, useText bool) (SQLImportInfo, error) {
	started := time.Now()
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind != "csv" && kind != "tsv" && kind != "jsonl" {
		return SQLImportInfo{}, errors.New("只支持 CSV / TSV / JSONL")
	}
	content, bytes, err := loadSQLSource(path, encoding, text, useText)
	if err != nil {
		return SQLImportInfo{}, err
	}
	if strings.TrimSpace(content) == "" {
		return SQLImportInfo{}, errors.New("文件为空")
	}
	var columns []sqlColumn
	var insertRows func(func([]any) error) error
	var rows int
	var truncated bool
	if kind == "jsonl" {
		columns, insertRows, rows, truncated, err = importJSONL(content)
	} else {
		columns, insertRows, rows, truncated, err = importCSV(content, csvDelimiter(content, kind))
	}
	if err != nil {
		return SQLImportInfo{}, err
	}
	session, err := createSQLTempDB()
	if err != nil {
		return SQLImportInfo{}, err
	}
	if err := session.createTable(columns); err != nil {
		session.dispose()
		return SQLImportInfo{}, err
	}
	if err := session.insertRows(len(columns), insertRows); err != nil {
		session.dispose()
		return SQLImportInfo{}, err
	}
	names := make([]string, len(columns))
	for i, col := range columns {
		names[i] = col.Name
	}
	info := SQLImportInfo{
		ID:        nextSQLSessionID(),
		Kind:      kind,
		Rows:      rows,
		Columns:   names,
		Bytes:     bytes,
		ElapsedMs: time.Since(started).Milliseconds(),
		Truncated: truncated,
	}
	session.info = info
	sqlSessionsMu.Lock()
	sqlSessions[info.ID] = session
	sqlSessionsMu.Unlock()
	return info, nil
}

func sqlCellString(value any) (string, bool) {
	switch v := value.(type) {
	case nil:
		return "", true
	case []byte:
		if utf8.Valid(v) {
			return string(v), false
		}
		return fmt.Sprintf("<BLOB %d bytes>", len(v)), false
	case int64:
		return strconv.FormatInt(v, 10), false
	case float64:
		return strconv.FormatFloat(v, 'g', -1, 64), false
	case bool:
		return strconv.FormatBool(v), false
	case time.Time:
		return v.Format(time.RFC3339), false
	case string:
		return v, false
	default:
		return fmt.Sprint(v), false
	}
}

func (a *App) SQLQuery(id, query string, limit int) (SQLResult, error) {
	started := time.Now()
	query = strings.TrimSpace(query)
	if query == "" {
		return SQLResult{}, errors.New("SQL 不能为空")
	}
	if sqlWritesOutsideSession(query) {
		return SQLResult{}, errors.New("SQL 视图只操作临时副本，不支持 ATTACH / DETACH / VACUUM")
	}
	if limit <= 0 {
		limit = sqlQueryRowDefault
	}
	if limit > sqlQueryRowMax {
		limit = sqlQueryRowMax
	}
	sqlSessionsMu.Lock()
	session := sqlSessions[id]
	sqlSessionsMu.Unlock()
	if session == nil || session.closed {
		return SQLResult{}, errors.New("查询会话不存在，请重新导入")
	}
	ctx, cancel := context.WithTimeout(context.Background(), sqlQueryTimeout)
	defer cancel()
	rows, err := session.db.QueryContext(ctx, query)
	if err != nil {
		return SQLResult{}, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return SQLResult{}, err
	}
	result := SQLResult{Columns: columns}
	if len(columns) == 0 {
		result.Message = "语句已执行（无结果集）"
		result.ElapsedMs = time.Since(started).Milliseconds()
		return result, nil
	}
	for rows.Next() {
		if len(result.Rows) >= limit {
			result.Truncated = true
			break
		}
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return SQLResult{}, err
		}
		row := make([]string, len(columns))
		nulls := make([]bool, len(columns))
		for i, value := range values {
			row[i], nulls[i] = sqlCellString(value)
		}
		result.Rows = append(result.Rows, row)
		result.Nulls = append(result.Nulls, nulls)
	}
	if err := rows.Err(); err != nil {
		return SQLResult{}, err
	}
	result.ElapsedMs = time.Since(started).Milliseconds()
	return result, nil
}

func (a *App) SQLClose(id string) error {
	sqlSessionsMu.Lock()
	session := sqlSessions[id]
	delete(sqlSessions, id)
	sqlSessionsMu.Unlock()
	if session != nil {
		session.dispose()
	}
	return nil
}

// cleanupSQLTempFiles 清理上次运行遗留的临时查询库（只删 7 天前的，避免误删长时间开着的会话）。
func cleanupSQLTempFiles() {
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "cadt-sql-*.db*"))
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	for _, path := range matches {
		info, err := os.Stat(path)
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(path)
		}
	}
}
