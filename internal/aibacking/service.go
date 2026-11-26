package aibacking

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。

// Service 是会话沙盒（backing workspace）的绑定承载类型。
type Service struct{}

// AIBackingWorkspace 返回该会话的沙盒目录绝对路径（不存在则创建）。
// 前端 sessionBackingWorkspace(session) 用它实现 scopeRootOf 第 2 步（noWorkspace 会话）。
func (s *Service) AIBackingWorkspace(sessionID string) (string, error) {
	return Workspace(sessionID)
}
