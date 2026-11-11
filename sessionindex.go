package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// AI 会话搜索索引：JSONL 仍是唯一真源，这里只保存可重建的检索副本。
// 首次搜索时才创建 DB；之后每次写会话只标脏，下一次搜索按会话重建。
const (
	aiIndexFileName  = "ai-index.db"
	aiIndexTextLimit = 200000 // 单条消息入索引的字符上限
)

type AISessionSearchHit struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Role      string `json:"role"`
	Name      string `json:"name"`
	Mid       string `json:"mid"`
	LiveIndex int    `json:"liveIndex"`
	Snippet   string `json:"snippet"`
	Kind      string `json:"kind"`
}

type AISessionIndexStats struct {
	Exists    bool  `json:"exists"`
	Sessions  int   `json:"sessions"`
	Messages  int   `json:"messages"`
	Dirty     int   `json:"dirty"`
	Bytes     int64 `json:"bytes"`
	Trigram   bool  `json:"trigram"`
	IndexedAt int64 `json:"indexedAt"`
}

type aiIndexMessage struct {
	Mid  string
	Role string
	Name string
	Ts   int64
	Text string
}

var (
	aiIndexMu      sync.Mutex
	aiIndexDB      *sql.DB
	aiIndexDBPath  string
	aiIndexTrigram bool
)

func aiIndexPath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, aiIndexFileName)
}

func aiIndexExists() bool {
	path := aiIndexPath()
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func aiIndexDatabase() (*sql.DB, error) {
	path := aiIndexPath()
	if path == "" {
		return nil, errors.New("无法定位应用数据目录")
	}
	aiIndexMu.Lock()
	defer aiIndexMu.Unlock()
	if aiIndexDB != nil && aiIndexDBPath == path {
		return aiIndexDB, nil
	}
	if aiIndexDB != nil {
		_ = aiIndexDB.Close()
		aiIndexDB = nil
	}
	db, trigram, err := openSessionIndex(path)
	if err != nil {
		return nil, err
	}
	aiIndexDB = db
	aiIndexDBPath = path
	aiIndexTrigram = trigram
	return db, nil
}

func openSessionIndex(path string) (*sql.DB, bool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, false, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, false, err
	}
	// 单连接串行化本进程内的索引读写；跨进程由 busy_timeout + WAL 处理。
	db.SetMaxOpenConns(1)
	_ = db.QueryRow("PRAGMA busy_timeout=5000").Scan(new(int))
	_ = db.QueryRow("PRAGMA journal_mode=WAL").Scan(new(string))
	_ = db.QueryRow("PRAGMA synchronous=NORMAL").Scan(new(string))
	if err := ensureSessionIndexSchema(db); err != nil {
		db.Close()
		return nil, false, err
	}
	trigram := false
	var ddl string
	if err := db.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_messages_fts'").Scan(&ddl); err == nil {
		trigram = strings.Contains(strings.ToLower(ddl), "trigram")
	}
	return db, trigram, nil
}

func ensureSessionIndexSchema(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL DEFAULT '',
			workspace TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL DEFAULT 0,
			archived_at INTEGER NOT NULL DEFAULT 0,
			message_count INTEGER NOT NULL DEFAULT 0,
			archived_count INTEGER NOT NULL DEFAULT 0,
			dirty INTEGER NOT NULL DEFAULT 1,
			indexed_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS messages (
			session_id TEXT NOT NULL,
			live_index INTEGER NOT NULL,
			mid TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			ts INTEGER NOT NULL DEFAULT 0,
			text TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON messages(session_id, live_index)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	if _, err := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='trigram')`); err != nil {
		// 旧版 SQLite 没有 trigram tokenizer 时退回默认分词，搜索会自动走 LIKE 兜底。
		if _, err2 := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(text, content='messages', content_rowid='rowid')`); err2 != nil {
			return err2
		}
	}
	triggers := []string{
		`CREATE TRIGGER IF NOT EXISTS ai_messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO ai_messages_fts(rowid, text) VALUES (new.rowid, new.text);
		END`,
		`CREATE TRIGGER IF NOT EXISTS ai_messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO ai_messages_fts(ai_messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
		END`,
		`CREATE TRIGGER IF NOT EXISTS ai_messages_au AFTER UPDATE ON messages BEGIN
			INSERT INTO ai_messages_fts(ai_messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
			INSERT INTO ai_messages_fts(rowid, text) VALUES (new.rowid, new.text);
		END`,
	}
	for _, stmt := range triggers {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

// replayIndexEvents 只做检索需要的轻量重放：msg / truncate / archive / reset。
func replayIndexEvents(raw string) (live, archived []aiIndexMessage) {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event struct {
			T    string `json:"t"`
			A    int    `json:"a"`
			Mid  string `json:"mid"`
			Keep int    `json:"keep"`
			M    *struct {
				Role      string `json:"role"`
				Content   string `json:"content"`
				Reasoning string `json:"reasoning"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
				Ts        int64  `json:"ts"`
			} `json:"m"`
		}
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		switch event.T {
		case "msg":
			if event.M == nil {
				continue
			}
			parts := make([]string, 0, 4)
			if event.M.Content != "" {
				parts = append(parts, event.M.Content)
			}
			if event.M.Reasoning != "" {
				parts = append(parts, event.M.Reasoning)
			}
			if event.M.Name != "" {
				parts = append(parts, event.M.Name)
			}
			if event.M.Arguments != "" {
				parts = append(parts, event.M.Arguments)
			}
			text := strings.TrimSpace(strings.Join(parts, "\n"))
			if text == "" {
				continue
			}
			if runes := []rune(text); len(runes) > aiIndexTextLimit {
				text = string(runes[:aiIndexTextLimit])
			}
			message := aiIndexMessage{Mid: event.Mid, Role: event.M.Role, Name: event.M.Name, Ts: event.M.Ts, Text: text}
			if event.A == 1 {
				archived = append(archived, message)
			} else {
				live = append(live, message)
			}
		case "truncate":
			keep := event.Keep
			if keep < 0 {
				keep = 0
			}
			if keep < len(live) {
				live = live[:keep]
			}
		case "archive":
			keep := event.Keep
			if keep < 0 {
				keep = 0
			}
			if keep > len(live) {
				keep = len(live)
			}
			archived = append(archived, live[:keep]...)
			live = append([]aiIndexMessage(nil), live[keep:]...)
		case "reset":
			live = nil
			archived = nil
		}
	}
	return live, archived
}

func indexSessionLog(db *sql.DB, id, raw string) error {
	live, archived := replayIndexEvents(raw)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM messages WHERE session_id=?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO messages(session_id, live_index, mid, role, name, ts, text) VALUES(?,?,?,?,?,?,?)`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for index, message := range live {
		if _, err := stmt.Exec(id, index, message.Mid, message.Role, message.Name, message.Ts, message.Text); err != nil {
			stmt.Close()
			_ = tx.Rollback()
			return err
		}
	}
	for _, message := range archived {
		if _, err := stmt.Exec(id, -1, message.Mid, message.Role, message.Name, message.Ts, message.Text); err != nil {
			stmt.Close()
			_ = tx.Rollback()
			return err
		}
	}
	stmt.Close()
	if _, err := tx.Exec(`UPDATE sessions SET message_count=?, archived_count=?, dirty=0, indexed_at=? WHERE id=?`,
		len(live), len(archived), time.Now().UnixMilli(), id); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

type aiIndexMeta struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Workspace     string `json:"workspace"`
	UpdatedAt     int64  `json:"updatedAt"`
	ArchivedAt    int64  `json:"archivedAt"`
	MessageCount  int    `json:"messageCount"`
	ArchivedCount int    `json:"archivedCount"`
}

func syncSessionIndex(db *sql.DB, store *aiSessionStore) error {
	metas, err := store.list()
	if err != nil {
		return err
	}
	seen := make(map[string]bool, len(metas))
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, raw := range metas {
		var meta aiIndexMeta
		if json.Unmarshal([]byte(raw), &meta) != nil || meta.ID == "" {
			continue
		}
		seen[meta.ID] = true
		if _, err := tx.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, archived_at, message_count, archived_count, dirty, indexed_at)
			VALUES(?,?,?,?,?,?,?,1,0)
			ON CONFLICT(id) DO UPDATE SET
				title=excluded.title, workspace=excluded.workspace, updated_at=excluded.updated_at,
				archived_at=excluded.archived_at`,
			meta.ID, meta.Title, meta.Workspace, meta.UpdatedAt, meta.ArchivedAt, meta.MessageCount, meta.ArchivedCount); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	rows, err := tx.Query(`SELECT id FROM sessions`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	stale := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			_ = tx.Rollback()
			return err
		}
		if !seen[id] {
			stale = append(stale, id)
		}
	}
	rows.Close()
	for _, id := range stale {
		if _, err := tx.Exec(`DELETE FROM messages WHERE session_id=?`, id); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.Exec(`DELETE FROM sessions WHERE id=?`, id); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	rows, err = db.Query(`SELECT id FROM sessions WHERE dirty=1 ORDER BY updated_at DESC`)
	if err != nil {
		return err
	}
	dirtyIDs := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		dirtyIDs = append(dirtyIDs, id)
	}
	rows.Close()
	for _, id := range dirtyIDs {
		raw, err := store.read(id)
		if err != nil {
			continue
		}
		if err := indexSessionLog(db, id, raw); err != nil {
			return err
		}
	}
	return nil
}

func makeSearchSnippet(text, query string, radius int) string {
	lowerText := strings.ToLower(text)
	lowerQuery := strings.ToLower(query)
	pos := strings.Index(lowerText, lowerQuery)
	if pos < 0 {
		runes := []rune(text)
		if len(runes) > radius*2 {
			runes = runes[:radius*2]
		}
		return string(runes)
	}
	start := pos - radius
	if start < 0 {
		start = 0
	}
	for start > 0 && !utf8.RuneStart(text[start]) {
		start--
	}
	end := pos + len(query) + radius
	if end > len(text) {
		end = len(text)
	}
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end++
	}
	matchEnd := pos + len(query)
	if matchEnd > len(text) {
		matchEnd = len(text)
	}
	prefix := "…"
	if start == 0 {
		prefix = ""
	}
	suffix := "…"
	if end >= len(text) {
		suffix = ""
	}
	return prefix + text[start:pos] + "\x01" + text[pos:matchEnd] + "\x02" + text[matchEnd:end] + suffix
}

func searchSessionIndex(db *sql.DB, trigram bool, query string, limit int) ([]AISessionSearchHit, error) {
	hits := make([]AISessionSearchHit, 0, limit)
	rows, err := db.Query(`SELECT id, title FROM sessions WHERE instr(lower(title), lower(?)) > 0 ORDER BY updated_at DESC LIMIT ?`, query, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			rows.Close()
			return nil, err
		}
		hits = append(hits, AISessionSearchHit{SessionID: id, Title: title, LiveIndex: -1, Kind: "title"})
	}
	rows.Close()
	if len(hits) >= limit {
		return hits, nil
	}
	remaining := limit - len(hits)
	useFTS := trigram && utf8.RuneCountInString(query) >= 3
	if useFTS {
		match := `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
		rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.name, m.mid, m.live_index,
			snippet(ai_messages_fts, 0, char(1), char(2), '…', 32)
			FROM ai_messages_fts
			JOIN messages m ON m.rowid = ai_messages_fts.rowid
			JOIN sessions s ON s.id = m.session_id
			WHERE ai_messages_fts MATCH ? AND m.live_index >= 0
			ORDER BY bm25(ai_messages_fts) LIMIT ?`, match, remaining)
	} else {
		rows, err = db.Query(`SELECT m.session_id, s.title, m.role, m.name, m.mid, m.live_index, m.text
			FROM messages m JOIN sessions s ON s.id = m.session_id
			WHERE m.live_index >= 0 AND instr(lower(m.text), lower(?)) > 0
			ORDER BY s.updated_at DESC, m.live_index DESC LIMIT ?`, query, remaining)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var hit AISessionSearchHit
		var snippet string
		if err := rows.Scan(&hit.SessionID, &hit.Title, &hit.Role, &hit.Name, &hit.Mid, &hit.LiveIndex, &snippet); err != nil {
			return nil, err
		}
		if !useFTS {
			snippet = makeSearchSnippet(snippet, query, 60)
		}
		hit.Snippet = snippet
		hit.Kind = "message"
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

// ---------- 写路径钩子（索引未创建时零开销） ----------

func aiIndexMarkDirty(id string) {
	if !aiIndexExists() {
		return
	}
	db, err := aiIndexDatabase()
	if err != nil {
		return
	}
	_, _ = db.Exec(`INSERT INTO sessions(id, dirty, indexed_at) VALUES(?,1,0)
		ON CONFLICT(id) DO UPDATE SET dirty=1`, id)
}

func aiIndexUpdateMeta(id, metaJSON string) {
	if !aiIndexExists() {
		return
	}
	db, err := aiIndexDatabase()
	if err != nil {
		return
	}
	var meta aiIndexMeta
	if json.Unmarshal([]byte(metaJSON), &meta) != nil || meta.ID == "" {
		return
	}
	_, _ = db.Exec(`INSERT INTO sessions(id, title, workspace, updated_at, archived_at, message_count, archived_count, dirty, indexed_at)
		VALUES(?,?,?,?,?,?,?,1,0)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title, workspace=excluded.workspace, updated_at=excluded.updated_at,
			archived_at=excluded.archived_at, message_count=excluded.message_count,
			archived_count=excluded.archived_count`,
		id, meta.Title, meta.Workspace, meta.UpdatedAt, meta.ArchivedAt, meta.MessageCount, meta.ArchivedCount)
}

func aiIndexDelete(id string) {
	if !aiIndexExists() {
		return
	}
	db, err := aiIndexDatabase()
	if err != nil {
		return
	}
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_, _ = tx.Exec(`DELETE FROM messages WHERE session_id=?`, id)
	_, _ = tx.Exec(`DELETE FROM sessions WHERE id=?`, id)
	_ = tx.Commit()
}

func aiIndexClear() {
	if !aiIndexExists() {
		return
	}
	db, err := aiIndexDatabase()
	if err != nil {
		return
	}
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_, _ = tx.Exec(`DELETE FROM messages`)
	_, _ = tx.Exec(`DELETE FROM sessions`)
	_ = tx.Commit()
}

// ---------- Wails 绑定 ----------

func (a *App) AISessionSearch(query string, limit int) ([]AISessionSearchHit, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return []AISessionSearchHit{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	db, err := aiIndexDatabase()
	if err != nil {
		return nil, err
	}
	store, err := defaultAISessionStore()
	if err != nil {
		return nil, err
	}
	if err := syncSessionIndex(db, store); err != nil {
		return nil, err
	}
	return searchSessionIndex(db, aiIndexTrigram, q, limit)
}

func resetSessionIndexFiles() {
	aiIndexMu.Lock()
	if aiIndexDB != nil {
		_ = aiIndexDB.Close()
		aiIndexDB = nil
	}
	aiIndexDBPath = ""
	aiIndexTrigram = false
	path := aiIndexPath()
	aiIndexMu.Unlock()
	if path == "" {
		return
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
}

func (a *App) AISessionReindex() (int, error) {
	// 显式重建 = 删掉派生索引后从 JSONL 全量重来，也用来恢复损坏的索引。
	resetSessionIndexFiles()
	db, err := aiIndexDatabase()
	if err != nil {
		return 0, err
	}
	store, err := defaultAISessionStore()
	if err != nil {
		return 0, err
	}
	if err := syncSessionIndex(db, store); err != nil {
		return 0, err
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM sessions WHERE dirty=0`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (a *App) AISessionIndexStats() (AISessionIndexStats, error) {
	stats := AISessionIndexStats{Exists: aiIndexExists()}
	if !stats.Exists {
		return stats, nil
	}
	db, err := aiIndexDatabase()
	if err != nil {
		return stats, err
	}
	store, err := defaultAISessionStore()
	if err != nil {
		return stats, err
	}
	if err := syncSessionIndex(db, store); err != nil {
		return stats, err
	}
	stats.Exists = true
	stats.Trigram = aiIndexTrigram
	if err := db.QueryRow(`SELECT count(*) FROM sessions`).Scan(&stats.Sessions); err != nil {
		return stats, err
	}
	if err := db.QueryRow(`SELECT count(*) FROM messages`).Scan(&stats.Messages); err != nil {
		return stats, err
	}
	if err := db.QueryRow(`SELECT count(*) FROM sessions WHERE dirty=1`).Scan(&stats.Dirty); err != nil {
		return stats, err
	}
	if err := db.QueryRow(`SELECT COALESCE(max(indexed_at),0) FROM sessions`).Scan(&stats.IndexedAt); err != nil {
		return stats, err
	}
	if info, err := os.Stat(aiIndexPath()); err == nil {
		stats.Bytes = info.Size()
	}
	return stats, nil
}

func (a *App) AISessionIndexPath() (string, error) {
	return aiIndexPath(), nil
}
