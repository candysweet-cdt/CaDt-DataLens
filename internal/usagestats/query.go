// query.go：编排 supervisor 使用的按会话用量查询（包内能力，不新增 Wails 绑定）。
package usagestats

import (
	"database/sql"
	"strings"
)

// SessionTokens 返回某个会话的累计 token 与是否存在用量事实。
// 编排预算熔断只看事实库，模型侧的 usage 缺失时按 0 处理，不估算。
func SessionTokens(sessionID string) (int64, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return 0, false
	}
	var tokens int64
	var count int64
	if err := withDB(func(conn *sql.DB) error {
		return conn.QueryRow(`SELECT COALESCE(SUM(total_tokens), 0), COUNT(*)
			FROM usage_events WHERE session_id = ?`, sessionID).Scan(&tokens, &count)
	}); err != nil {
		logf("warn", "AI 使用统计按会话查询失败（%s）：%v", sessionID, err)
		return 0, false
	}
	if tokens < 0 {
		tokens = 0
	}
	return tokens, count > 0
}
