package gitinfo

// service.go：Wails 绑定承载类型（原根 gitinfo_app.go，37 条 Git 绑定）。
// App 匿名嵌入 *Service 后方法自动进 *App 方法集，前端 FQN 仍是 main.App.Git<x>。
// 工作树写静默钩子（OnMutateWorktree）在根 host_wiring.go 注入。

// Service 是 Git 浅集成的绑定承载类型。
type Service struct{}

func (s *Service) GitStatusFor(dir string) (*GitTreeStatus, error) {
	return StatusFor(dir)
}

func (s *Service) GitBranchesFor(dir string, includeRemote bool) (*GitBranchesResult, error) {
	return BranchesFor(dir, includeRemote)
}

func (s *Service) GitCheckoutBranch(dir string, name string, remote bool) (*GitOperationResult, error) {
	return CheckoutBranch(dir, name, remote)
}

func (s *Service) GitCreateBranch(dir string, name string) (*GitOperationResult, error) {
	return CreateBranch(dir, name)
}

func (s *Service) GitCheckoutRefFor(dir string, ref string) (*GitOperationResult, error) {
	return CheckoutRef(dir, ref)
}

func (s *Service) GitPullFor(dir string) (*GitOperationResult, error) {
	return Pull(dir)
}

func (s *Service) GitPushFor(dir string) (*GitOperationResult, error) {
	return Push(dir)
}

func (s *Service) GitFetchFor(dir string) (*GitOperationResult, error) {
	return Fetch(dir)
}

func (s *Service) GitCloneRepository(url string, target string) (*GitOperationResult, error) {
	return CloneRepository(url, target)
}

func (s *Service) GitCommitChanges(dir string, message string, paths []string, amend bool, push bool) (*GitCommitResult, error) {
	return CommitChanges(dir, message, paths, amend, push)
}

func (s *Service) GitRollbackFor(dir string, paths []string, untracked []string) error {
	return RollbackFor(dir, paths, untracked)
}

func (s *Service) GitFileHistoryFor(dir string, path string, limit int) (string, error) {
	return FileHistoryFor(dir, path, limit)
}

func (s *Service) GitRecentLogFor(dir string, limit int) (string, error) {
	return RecentLogFor(dir, limit)
}

func (s *Service) GitDiffFor(dir string, path string) (*GitDiffResult, error) {
	return DiffFor(dir, path)
}

func (s *Service) GitLineMarksFor(dir string, path string, content string) (*GitLineMarks, error) {
	return LineMarksFor(dir, path, content)
}

// ===== AI 隔离 worktree（引擎在 internal/gitinfo/worktree.go；回灌审批仍走 patch 壳与前端） =====

func (s *Service) GitWorktreeList(dir string) (*GitWorktreeListResult, error) {
	return WorktreeList(dir)
}

func (s *Service) GitWorktreeAdd(dir, label, sessionKey string, carry bool) (*GitWorktreeAddResult, error) {
	return WorktreeAdd(dir, label, sessionKey, carry)
}

func (s *Service) GitWorktreeRemove(dir, name string, deleteBranch bool) error {
	return WorktreeRemove(dir, name, deleteBranch)
}

func (s *Service) GitWorktreePrune(dir string) error {
	return WorktreePrune(dir)
}

func (s *Service) GitWorktreeDiff(dir, name, baseSha string) (string, error) {
	return WorktreeDiff(dir, name, baseSha)
}

func (s *Service) GitWorktreeStat(dir, name, baseSha string) (string, error) {
	return WorktreeStat(dir, name, baseSha)
}

// GitWorktreeMergePreview export 的零副作用三方合并预检（L1 dry-run；快照/merge-tree/报告
// 落盘都在引擎内）。Supported=false 时前端降级走 PatchPreviewText/PatchSave 兜底链路。
func (s *Service) GitWorktreeMergePreview(dir, name, baseSha string) (*GitWorktreeMergePreviewResult, error) {
	return WorktreeMergePreview(dir, name, baseSha)
}

// GitPatchID diff 文本的稳定指纹（L0 已应用识别的第一层，stdin 喂给 git patch-id --stable）。
func (s *Service) GitPatchID(diffText string) (string, error) {
	return PatchID(diffText)
}

// GitWorktreeMergeApply 审批通过后的应用换轨（S2）：按三方合并结果把选中文件写回主根
// 工作区。与预检共用同一引擎（runMergeCore），应用瞬间重新跑合并保证一致性；不碰 index。
func (s *Service) GitWorktreeMergeApply(dir, name, baseSha string, paths []string) (*GitWorktreeMergeApplyResult, error) {
	return WorktreeMergeApply(dir, name, baseSha, paths)
}

// GitWorktreeSnapshotPatch discard 保底快照（S3）：隔离区当前 diff 原样落盘 .cadt/patches/，
// 绕开 PatchSave 的「不可应用即删」；无改动返回 ErrWorktreeNoChanges。
func (s *Service) GitWorktreeSnapshotPatch(dir, name, baseSha string) (string, error) {
	return WorktreeSnapshotPatch(dir, name, baseSha)
}

// GitWorktreeDiffSinceBase 主根相对基准的单文件 diff（S3 conflict_detail 按需通道，行数封顶）。
func (s *Service) GitWorktreeDiffSinceBase(dir, baseSha, path string, maxLines int) (string, error) {
	return WorktreeDiffSinceBase(dir, baseSha, path, maxLines)
}

// ===== Git 图谱（引擎在 internal/gitinfo/graph.go；泳道在 Go 侧算好，前端只渲染） =====

func (s *Service) GitGraphCommits(dir, ref string, limit, skip int) (*GitGraphPage, error) {
	return GraphCommits(dir, ref, limit, skip)
}

func (s *Service) GitGraphRefs(dir string) (*GitGraphRefsResult, error) {
	return GraphRefs(dir)
}

func (s *Service) GitGraphCheckout(dir, ref string) (*GitOperationResult, error) {
	return GraphCheckout(dir, ref)
}

func (s *Service) GitGraphReset(dir, sha, mode string) (*GitOperationResult, error) {
	return GraphReset(dir, sha, mode)
}

func (s *Service) GitGraphCherryPick(dir, sha string) (*GitOperationResult, error) {
	return GraphCherryPick(dir, sha)
}

func (s *Service) GitGraphCreateBranch(dir, name, sha string, checkout bool) (*GitOperationResult, error) {
	return GraphCreateBranch(dir, name, sha, checkout)
}

func (s *Service) GitGraphCheckoutForce(dir, ref string) (*GitOperationResult, error) {
	return GraphCheckoutForce(dir, ref)
}

func (s *Service) GitGraphCheckoutSmart(dir, ref string) (*GitOperationResult, error) {
	return GraphCheckoutSmart(dir, ref)
}

func (s *Service) GitGraphCommitFiles(dir, sha string) ([]GitGraphFileChange, error) {
	return GraphCommitFiles(dir, sha)
}

func (s *Service) GitGraphCommitBody(dir, sha string) (string, error) {
	return GraphCommitBody(dir, sha)
}

// GitGraphCommitFileDiff 返回一次提交中单个文件的 diff（图谱「本次变动」树点击文件用）。
func (s *Service) GitGraphCommitFileDiff(dir, sha, path string, maxLines int) (*GitDiffResult, error) {
	return GraphCommitFileDiff(dir, sha, path, maxLines)
}
