package mavenproject

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 maven_app.go）逐字一致，前端零改动。

// Service 是 Maven 工具窗口的绑定承载类型。
type Service struct{}

// MavenProjectInfo 读工作区 Maven 项目结构（pom 元数据 + 模块树 + settings.xml 位置），纯文件读取。
func (s *Service) MavenProjectInfo(root string) (*ProjectInfo, error) {
	return ReadProject(root)
}

// MavenData 起一条 mvn 数据命令（kind：effective-pom / effective-settings / dependency-tree），
// 返回原始文本，解析在前端。moduleRelPath 非空时加 -pl（仅对支持该参数的目标生效）。
func (s *Service) MavenData(workspaceRoot, mvnPath string, timeoutMs int, kind, moduleRelPath string) (string, error) {
	return RunData(workspaceRoot, mvnPath, timeoutMs, kind, moduleRelPath)
}
