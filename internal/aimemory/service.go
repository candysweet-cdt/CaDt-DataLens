package aimemory

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。

// Service 是 AI 记忆写入通道的绑定承载类型。
type Service struct{}

// AIMemoryWrite memory_write 工具的后端通道：把一份记忆整体写入记忆目录（锁 + 原子替换），
// 返回落盘绝对路径。dir 是解析好的记忆目录（<工作区>/.cadt/memory 或 <应用数据>/ai-memory），
// name 只允许单层 .md 文件名。
//
// 前端的调用点留到批次 E（那轮才碰 ai-panel.js），在那之前本方法只有测试与真机手验会调到。
func (s *Service) AIMemoryWrite(dir string, name string, content string) (string, error) {
	return Write(dir, name, content)
}
