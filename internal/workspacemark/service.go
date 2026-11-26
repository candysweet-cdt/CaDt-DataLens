package workspacemark

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。

// Service 是「工作区已打开过」账本的绑定承载类型。
type Service struct{}

// WorkspaceMarkOpened 登记并返回「是否首次」：true = 调用方该跑重活（open 钩子 /
// 首次 git status / 首次指纹基线），false = 本进程已经跑过，跳过。
func (s *Service) WorkspaceMarkOpened(dir string) bool {
	return MarkOpened(dir)
}
