package patch

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 目前只有只读审阅解析这一条走「服务提升」；补丁的保存/应用/撤销/列表涉及根目录
// 解析与写回备份钩子，仍留在根的 patch_app.go（真宿主编排）。

// Service 是补丁只读审阅的绑定承载类型。
type Service struct{}

// PatchParseText 解析补丁文本供只读审阅展示，不生成任何可应用的计划。
func (s *Service) PatchParseText(text string) (*PatchPreview, error) {
	return ParseReviewText(text)
}
