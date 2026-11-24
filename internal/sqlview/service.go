package sqlview

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 sqlview_app.go）逐字一致，前端零改动。
//
// 只读 SQL 查询：导入临时 SQLite，不修改原文件。

// Service 是只读 SQL 查询的绑定承载类型。
type Service struct{}

// SQLImport 把 CSV/TSV/JSONL 导入临时 SQLite，返回列信息与临时 id。
func (s *Service) SQLImport(path, kind, encoding, text string, useText bool) (SQLImportInfo, error) {
	return Import(path, kind, encoding, text, useText)
}

// SQLQuery 在临时库上执行只读查询。
func (s *Service) SQLQuery(id, query string, limit int) (SQLResult, error) {
	return Query(id, query, limit)
}

// SQLClose 释放临时库。
func (s *Service) SQLClose(id string) error {
	return Close(id)
}
