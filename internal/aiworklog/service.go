package aiworklog

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 ai_worklog_app.go）一致，前端零改动。
// 日志注入（Logf）留在根 host_wiring.go。

// Service 是 AI 工作日志的绑定承载类型。
type Service struct{}

// AIWorklogAppend write_worklog 工具的后端通道：向 <工作区>/.cadt/logs/ 追加一条工作日志，
// 返回条目正文的绝对路径。root 必须是绝对路径的工作区根；标题必填，摘要可选。
func (s *Service) AIWorklogAppend(root string, title string, summary string) (string, error) {
	return Append(root, title, summary)
}
