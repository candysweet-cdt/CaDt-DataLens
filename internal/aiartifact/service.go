package aiartifact

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 ai_artifact_app.go）逐字一致，前端零改动。
// 宿主注入（应用数据目录）由根 host_wiring.go 通过包级变量完成。

// Service 是工具结果落盘区的绑定承载类型。
type Service struct{}

// AIArtifactWrite 把一段超长工具结果落盘，返回绝对路径（路径由宿主决定，前端不能指定目录）。
func (s *Service) AIArtifactWrite(sessionID string, name string, content string) (string, error) {
	return Write(sessionID, name, content)
}

// AIArtifactRead 读回一份产物（重启后补读子代理转录用）；不存在返回空串。
func (s *Service) AIArtifactRead(sessionID string, name string) (string, error) {
	return Read(sessionID, name)
}

// AIArtifactClear 删除某会话的全部产物（删会话时调用）。
func (s *Service) AIArtifactClear(sessionID string) error {
	return ClearSession(sessionID)
}

// AIArtifactClearAll 删除全部产物（删除所有会话时调用；也是一键清缓存里的同名条目）。
func (s *Service) AIArtifactClearAll() error {
	return ClearAll()
}
