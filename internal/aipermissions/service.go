package aipermissions

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。

// Service 是权限规则写通道的绑定承载类型。
type Service struct{}

// AIProjectRulesWrite 权限规则的后端写通道：锁 + 原子替换，返回落盘绝对路径。
// root 是工作区根绝对路径；jsonText 必须是合法 JSON 对象（坏 JSON 直接报错，不落盘）。
func (s *Service) AIProjectRulesWrite(root string, jsonText string) (string, error) {
	return Write(root, jsonText)
}
