package envvars

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 envvars_app.go）逐字一致，前端零改动。
// 应用数据目录由根 host_wiring.go 注入（AppDataDir）。

// Service 是环境变量配置的绑定承载类型。
type Service struct{}

// GetEnvVars 返回变量快照（值永远不下发）。
func (s *Service) GetEnvVars() (*EnvVarSnapshot, error) {
	return Get()
}

// SetEnvVars 写入变量配置（值由用户在设置页填写）。
func (s *Service) SetEnvVars(inputs []EnvVarInput) error {
	return Set(inputs)
}

// SetEnvVarEncrypted 开关 DPAPI 加密（只影响后续写入）。
func (s *Service) SetEnvVarEncrypted(on bool) error {
	return SetEncrypted(on)
}
