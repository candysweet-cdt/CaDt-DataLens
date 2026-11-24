package activity

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 activity_app.go）逐字一致，前端零改动。
// 只放前端要调的方法；其余能力保持包级函数。

// Service 是操作留痕的绑定承载类型。
type Service struct{}

// ActivityAppend 追加一条操作留痕（只存操作摘要，不存正文与密钥）。
func (s *Service) ActivityAppend(entriesJSON string) error {
	return Append(entriesJSON)
}

// ActivityRead 按查询条件读留痕（返回 JSON 文本）。
func (s *Service) ActivityRead(queryJSON string) (string, error) {
	return Read(queryJSON)
}

// ActivityClear 清空留痕。
func (s *Service) ActivityClear() error {
	return Clear()
}

// ActivityPath 返回留痕文件路径（前端展示用）。
func (s *Service) ActivityPath() (string, error) {
	return Path()
}
