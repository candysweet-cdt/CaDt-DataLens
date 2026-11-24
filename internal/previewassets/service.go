package previewassets

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 app_preview_assets.go）一致，前端零改动。

// Service 是预览资源注册表的绑定承载类型。
type Service struct{}

// RegisterPreviewRoot 供前端注册 HTML 预览的资源根目录，返回访问 token。
func (s *Service) RegisterPreviewRoot(dir string) (string, error) {
	return Register(dir)
}
