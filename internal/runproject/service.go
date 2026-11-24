package runproject

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 run_project_app.go）一致，前端零改动。

// Service 是项目感知运行的绑定承载类型。
type Service struct{}

// DetectRunProject 从文件或目录向上探测项目标记，返回项目根与候选命令。
func (s *Service) DetectRunProject(path string) (*RunProjectInfo, error) {
	return Detect(path)
}
