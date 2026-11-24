package aiimagepolicy

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 ai_image_policy_app.go）一致，前端零改动。
//
// 限制值刻意不暴露设置页：与 codex / opencode / ZCode / dsh 一致，全部硬编码在引擎包内，
// 前端只消费同一份数值，避免前后端各写一份而漂。

// Service 是图片三层限制的投影类型。
type Service struct{}

// AIImageLimits 返回当前图片三层限制（源准入 / 归一化 / 请求预算）。
// 前端 ai-image-policy.js 的 load() 调它；失败或缺值回落到前端内置的镜像默认值。
func (s *Service) AIImageLimits() ImageLimits {
	return Get()
}
