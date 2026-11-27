// store.go：ai-usage.db 的生命周期、建表、事实写入与读取、扫描游标读写。
package usagestats

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS usage_events (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	model TEXT NOT NULL DEFAULT '',
	model_account TEXT NOT NULL DEFAULT '',
	prompt_tokens INTEGER NOT NULL DEFAULT 0,
	completion_tokens INTEGER NOT NULL DEFAULT 0,
	total_tokens INTEGER NOT NULL DEFAULT 0,
	cached_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0,
	turn_ms INTEGER NOT NULL DEFAULT 0,
	model_ms INTEGER NOT NULL DEFAULT 0,
	ttft_ms INTEGER NOT NULL DEFAULT 0,
	status_code INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);

CREATE TABLE IF NOT EXISTS usage_sync_state (
	session_id TEXT PRIMARY KEY,
	byte_offset INTEGER NOT NULL DEFAULT 0,
	file_size INTEGER NOT NULL DEFAULT 0,
	file_mtime INTEGER NOT NULL DEFAULT 0,
	prefix_hash TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL DEFAULT 0
);
`

const upsertEventSQL = `
INSERT INTO usage_events (
	id, session_id, ts, model, model_account,
	prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_write_tokens,
	turn_ms, model_ms, ttft_ms, status_code
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	ts = excluded.ts,
	model = excluded.model,
	model_account = excluded.model_account,
	prompt_tokens = excluded.prompt_tokens,
	completion_tokens = excluded.completion_tokens,
	total_tokens = excluded.total_tokens,
	cached_tokens = excluded.cached_tokens,
	cache_write_tokens = excluded.cache_write_tokens,
	turn_ms = excluded.turn_ms,
	model_ms = excluded.model_ms,
	ttft_ms = excluded.ttft_ms,
	status_code = excluded.status_code
`

func ensureDB() error {
	mu.Lock()
	defer mu.Unlock()
	return ensureDBLocked()
}

func ensureDBLocked() error {
	if dbHandle != nil {
		return nil
	}
	path := Path()
	if path == "" {
		return errors.New("应用数据目录不可用")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	conn.SetMaxOpenConns(1)
	// 单连接串行化本进程读写；多窗口跨进程由 busy_timeout + WAL 处理（同 sessionindex.go）。
	_, _ = conn.Exec("PRAGMA busy_timeout=5000")
	_, _ = conn.Exec("PRAGMA journal_mode=WAL")
	_, _ = conn.Exec("PRAGMA synchronous=NORMAL")
	if _, err := conn.Exec(schemaSQL); err != nil {
		_ = conn.Close()
		return err
	}
	// 老库补列（SQLite 没有 ADD COLUMN IF NOT EXISTS）：只忽略 duplicate column，
	// 其余错误（锁/只读/损坏）必须暴露，否则后续读写会持续失败且只留一条 warning。
	addedColumn := false
	for _, stmt := range []string{
		`ALTER TABLE usage_events ADD COLUMN turn_ms INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE usage_events ADD COLUMN model_ms INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE usage_events ADD COLUMN ttft_ms INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE usage_events ADD COLUMN status_code INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE usage_sync_state ADD COLUMN prefix_hash TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := conn.Exec(stmt); err != nil {
			if !strings.Contains(err.Error(), "duplicate column") {
				_ = conn.Close()
				return err
			}
		} else if strings.Contains(stmt, "usage_events") {
			addedColumn = true
		}
	}
	if addedColumn {
		// 新增时序/状态列后，旧游标对应的文件不会因为「没变化」被重读，历史事实就永远
		// 缺这些字段。清一次游标让下次打开面板全量重读（upsert 幂等，代价只在这一次）。
		if _, err := conn.Exec(`DELETE FROM usage_sync_state`); err != nil {
			logf("warn", "AI 使用统计清空扫描游标失败（新字段历史回填可能不完整）: %v", err)
		}
	}
	dbHandle = conn
	return nil
}

// db 取当前连接（仅供测试与诊断；业务路径用 withDB，见下）。
func db() *sql.DB {
	mu.RLock()
	defer mu.RUnlock()
	return dbHandle
}

// withDB 在持有读锁期间执行 fn。Close 的写锁会等所有在飞操作结束，
// 避免「拿到句柄 → 连接被关 → Exec 失败」导致用量事实静默丢失。
func withDB(fn func(*sql.DB) error) error {
	if err := ensureDB(); err != nil {
		return err
	}
	mu.RLock()
	defer mu.RUnlock()
	conn := dbHandle
	if conn == nil {
		return errors.New("统计库已关闭")
	}
	return fn(conn)
}

func upsertEvent(ev Event) error {
	return withDB(func(conn *sql.DB) error {
		_, err := conn.Exec(upsertEventSQL,
			ev.ID, ev.SessionID, ev.Ts, ev.Model, ev.ModelAccount,
			ev.PromptTokens, ev.CompletionTokens, ev.TotalTokens, ev.CachedTokens, ev.CacheWriteTokens,
			ev.TurnMs, ev.ModelMs, ev.TtftMs, ev.StatusCode)
		return err
	})
}

// loadEvents 读取全部用量事实。个人使用量级（万级）一次读入并在内存聚合，
// 与 ZCode「查询时全量重算、不建 rollup」同口径；将来变慢再加日汇总表。
func loadEvents() ([]Event, error) {
	events := make([]Event, 0, 256)
	err := withDB(func(conn *sql.DB) error {
		rows, err := conn.Query(`SELECT id, session_id, ts, model, model_account,
			prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_write_tokens,
			turn_ms, model_ms, ttft_ms, status_code
			FROM usage_events`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var ev Event
			if err := rows.Scan(&ev.ID, &ev.SessionID, &ev.Ts, &ev.Model, &ev.ModelAccount,
				&ev.PromptTokens, &ev.CompletionTokens, &ev.TotalTokens, &ev.CachedTokens, &ev.CacheWriteTokens,
				&ev.TurnMs, &ev.ModelMs, &ev.TtftMs, &ev.StatusCode); err != nil {
				return err
			}
			events = append(events, ev)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return events, nil
}

// loadRequestRows 请求日志分页查询：时间倒序（同一毫秒按 id 稳定排序）。
func loadRequestRows(offset, limit int) ([]RequestRow, int64, error) {
	items := make([]RequestRow, 0, limit)
	var total int64
	err := withDB(func(conn *sql.DB) error {
		if err := conn.QueryRow(`SELECT COUNT(*) FROM usage_events`).Scan(&total); err != nil {
			return err
		}
		rows, err := conn.Query(`SELECT ts, model, model_account,
			prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens,
			model_ms, ttft_ms, status_code
			FROM usage_events
			ORDER BY ts DESC, id DESC
			LIMIT ? OFFSET ?`, limit, offset)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row RequestRow
			if err := rows.Scan(&row.Ts, &row.Model, &row.ModelAccount,
				&row.PromptTokens, &row.CompletionTokens, &row.CachedTokens, &row.CacheWriteTokens,
				&row.ModelMs, &row.TtftMs, &row.StatusCode); err != nil {
				return err
			}
			items = append(items, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

// syncState 单个会话日志的增量游标：已消费到哪个字节、上次看到的文件大小与 mtime。
type syncState struct {
	Offset     int64
	Size       int64
	Mtime      int64
	PrefixHash string // offset 前 64 字节的短哈希：识别文件被截断/重写
}

// loadSyncStates 一轮扫描开始前一次性预取全部游标：会话多时避免每文件一次查询。
func loadSyncStates() (map[string]syncState, error) {
	states := make(map[string]syncState, 64)
	err := withDB(func(conn *sql.DB) error {
		rows, err := conn.Query(`SELECT session_id, byte_offset, file_size, file_mtime, prefix_hash FROM usage_sync_state`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var st syncState
			if err := rows.Scan(&id, &st.Offset, &st.Size, &st.Mtime, &st.PrefixHash); err != nil {
				return err
			}
			states[id] = st
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return states, nil
}

// saveScanResult 把一批事实与游标放在同一个事务里提交：要么整批可见，要么整批重来。
func saveScanResult(sessionID string, events []Event, offset, size, mtime int64, prefixHash string, now int64) error {
	return withDB(func(conn *sql.DB) error {
		return saveScanResultTx(conn, sessionID, events, offset, size, mtime, prefixHash, now)
	})
}

func saveScanResultTx(conn *sql.DB, sessionID string, events []Event, offset, size, mtime int64, prefixHash string, now int64) error {
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(upsertEventSQL)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, ev := range events {
		if _, err := stmt.Exec(ev.ID, ev.SessionID, ev.Ts, ev.Model, ev.ModelAccount,
			ev.PromptTokens, ev.CompletionTokens, ev.TotalTokens, ev.CachedTokens, ev.CacheWriteTokens,
			ev.TurnMs, ev.ModelMs, ev.TtftMs, ev.StatusCode); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO usage_sync_state
		(session_id, byte_offset, file_size, file_mtime, prefix_hash, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			byte_offset = excluded.byte_offset,
			file_size = excluded.file_size,
			file_mtime = excluded.file_mtime,
			prefix_hash = excluded.prefix_hash,
			updated_at = excluded.updated_at`,
		sessionID, offset, size, mtime, prefixHash, now); err != nil {
		return err
	}
	return tx.Commit()
}

// pruneSyncStates 清掉已不存在的会话游标（被删的会话目录不再回来；
// 误删游标只会让下次全量重读一次，写入幂等所以无害）。
func pruneSyncStates(found map[string]bool) {
	if len(found) == 0 {
		return
	}
	_ = withDB(func(conn *sql.DB) error {
		rows, err := conn.Query(`SELECT session_id FROM usage_sync_state`)
		if err != nil {
			return err
		}
		stale := make([]string, 0, 4)
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil && !found[id] {
				stale = append(stale, id)
			}
		}
		rows.Close()
		for _, id := range stale {
			_, _ = conn.Exec(`DELETE FROM usage_sync_state WHERE session_id = ?`, id)
		}
		return nil
	})
}
