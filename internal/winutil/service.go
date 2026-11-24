package winutil

// service.go：Wails 绑定承载类型。App 匿名嵌入 *Service 后，GetSystemCursors
// 自动进 *App 方法集，前端 FQN 仍是 main.App.GetSystemCursors。
// 平台实现（SystemCursors）在 winutil_windows.go / winutil_other.go。

// Service 是纯平台能力的绑定承载类型。
type Service struct{}

// GetSystemCursors 返回系统调整光标（含 base 基准尺寸）；非 Windows 返回空表。
func (s *Service) GetSystemCursors() map[string]string {
	return SystemCursors()
}
