package aigen

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 ai_gen_app.go）一致，前端零改动。
//
// 两条都是「哑通道」：前端渲染好请求规格，这里只发请求 / 落盘产物。

// Service 是生图/视频执行通道的绑定承载类型。
type Service struct{}

// AIGenHTTPRequest 按前端渲染好的规格发一次同步 HTTP。
func (s *Service) AIGenHTTPRequest(specJSON string) HTTPResult {
	return HTTPRequest(specJSON)
}

// AIGenSaveProducts 产物解码/下载 + 工作区路径校验落盘 .cadt/gen/。
func (s *Service) AIGenSaveProducts(specJSON string) SaveResult {
	return SaveProducts(specJSON)
}
