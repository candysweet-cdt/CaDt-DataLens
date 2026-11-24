package update

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 update_app.go）一致，前端零改动。
// 版本号由根 host_wiring.go 注入（Version）。

// Service 是检查更新的绑定承载类型。
type Service struct{}

// CheckForUpdates 检查 Gitee Release 上是否有新版本。
func (s *Service) CheckForUpdates() (*UpdateInfo, error) {
	return Check()
}
