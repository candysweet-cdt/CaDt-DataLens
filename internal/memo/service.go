package memo

// service.go：Wails 绑定承载类型——App 匿名嵌入 *Service 后，这里的导出方法
// 自动进 *App 方法集，前端 FQN 仍是 main.App.<Method>（v3 的绑定面就是
// *App 的方法集，见 wails v3 pkg/application/bindings.go:236）。
//
// 纪律：本类型只放「确实要暴露给前端」的方法；包内其它辅助能力保持包级函数或
// 小写方法，否则会顺手变成前端可调绑定（历史上 Scheduler.Start 就这么漏出去的，
// 由根目录 app_bindings_guard_test.go 的基线守卫拦）。
//
// 方法名必须与迁移前根壳（原 memo_app.go）逐字一致，前端零改动。

import "context"

// Service 是便签存储的绑定承载类型。
type Service struct{}

// MemoLoad 读一个作用域的 memo.json，返回信封 {"data":原文,"mtimeMs":N}。
func (s *Service) MemoLoad(scope, workspace string) (string, error) {
	return Load(scope, workspace)
}

// MemoSave 整份原子写；baseMtimeMs 为 0 表示载入时还没有文件，>0 做 CAS。
func (s *Service) MemoSave(scope, workspace, doc string, baseMtimeMs int64) SaveResult {
	return Save(scope, workspace, doc, baseMtimeMs)
}

// MemoSaveImage 贴图 data URL 落盘，返回相对引用路径 img/xxx.png。
func (s *Service) MemoSaveImage(scope, workspace, dataURL string) (string, error) {
	return SaveImage(scope, workspace, dataURL)
}

// MemoLeaseAcquire 取便签写权（打开面板时调用，按调用方窗口归属）；busy 返回
// owner（另一窗口/进程在编辑），不报错。
func (s *Service) MemoLeaseAcquire(ctx context.Context, scope, workspace, label string) (LeaseStatus, error) {
	return AcquireLease(scope, workspace, label, ownerForCall(ctx))
}

// MemoLeaseRelease 释放调用方窗口的便签写权（关闭面板/切作用域/关窗时调用）。
func (s *Service) MemoLeaseRelease(ctx context.Context, scope, workspace string) error {
	return ReleaseLease(scope, workspace, ownerForCall(ctx))
}

// MemoLeaseStatus 探测便签写权（只读横幅/定时接管用，不用于写决策）。
func (s *Service) MemoLeaseStatus(scope, workspace string) (LeaseStatus, error) {
	return LeaseStatusFor(scope, workspace)
}

// ownerForCall 取注入的「调用方窗口名」；未注入（测试/无窗口）时返回空串，
// 与旧的单桶语义一致。
func ownerForCall(ctx context.Context) string {
	if deps.OwnerForCall == nil {
		return ""
	}
	return deps.OwnerForCall(ctx)
}
