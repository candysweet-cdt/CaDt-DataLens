package aiusage

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 ai_usage_app.go）逐字一致，前端零改动。

import (
	"datalens/internal/aigen"
	"datalens/internal/aitransport"
)

// Service 是余额/用量查询的绑定承载类型。
type Service struct{}

// AIUsageQuery 走官方白名单引擎查询额度。
func (s *Service) AIUsageQuery(cfg aitransport.Config) AIUsageResult {
	return Query(cfg)
}

// AIUsageHTTPRequest 额度查询的哑通道：前端把模板变量替换与请求体渲染做完，
// 这里按规格发一次同步 HTTP（转发 aigen.HTTPRequest，代理/超时/响应上限沿用），
// 响应体原样回给前端沙箱里的 extractor 提取。错误摘要由 aigen 侧做密钥形态脱敏。
func (s *Service) AIUsageHTTPRequest(specJSON string) aigen.HTTPResult {
	return aigen.HTTPRequest(specJSON)
}
