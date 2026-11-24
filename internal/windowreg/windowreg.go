package windowreg

// windowreg.go：一进程多窗口的窗口元数据与注册表（纯状态层，与 Wails 无关）。
//
// 原本整块在根 windowmeta.go，与 *application.WebviewWindow 混在一个文件里。
// 这里只保留「窗口叫什么、属于哪个工作区、有没有脏标记 / AI 回合 / 收起 /
// 几何已应用」这类纯状态；窗口引用用泛型参数 W 表示，由根注入
// *application.WebviewWindow——internal 包因此保持零 Wails 依赖（与全仓
// 74 个包同一条口径，见 AGENTS.md「纯引擎下沉 internal」）。
//
// 辅助窗口的按条件查找（便签 / 监控 / 对比 / 轻量查看 / 实时预览）也只读 Spec，
// 一并收在这里：它们原在根 aux_windows.go，逻辑与窗口 API 无关。

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"datalens/internal/launchargs"
	"datalens/internal/windowgeom"
)

// Mode 是窗口形态：形态决定托盘/关闭/几何记忆/工作区复用的一整套行为。
type Mode string

const (
	ModeMain     Mode = "main"
	ModeFloat    Mode = "float"
	ModeDebug    Mode = "debug"
	ModeTerminal Mode = "terminal"
	ModeMemo     Mode = "memo"
	ModeMonitor  Mode = "monitor"
	ModeDiff     Mode = "diff"
	ModeLight    Mode = "light"
	ModePreview  Mode = "preview"
)

// Spec 是创建窗口时的启动上下文（等价 v2 的进程启动参数）。
type Spec struct {
	Name         string
	Mode         Mode
	Workspace    string
	Targets      []launchargs.OpenTarget
	SessionID    string
	SettingsPane string
	MemoLocator  string
	// TermID / Origin：终端独立窗口（ModeTerminal）——弹出的会话 id 与
	// 发起弹出的窗口名（关窗时把会话交还给它）。
	TermID string
	Origin string
	// MemoScope：便签独立窗口（ModeMemo）的作用域（workspace|global），
	// workspace 作用域时 Workspace 字段带工作区路径。
	MemoScope string
	// SessionKind：会话监控窗（ModeMonitor）的会话类型（session|group），
	// SessionID 字段复用为被监控的会话 id；Origin 是发起监控的窗口名。
	SessionKind string
	// DiffLeft / DiffRight：文件对比窗（ModeDiff）的两个对比文件路径。
	DiffLeft  string
	DiffRight string
	// LightPath：轻量查看窗（ModeLight）的文件路径（只读，磁盘真源）。
	LightPath string
	// PreviewPath：实时预览窗（ModePreview）的源文件路径；Origin 是
	// 持有该文档的窗口名（预览窗只读，轮询磁盘 mtime 跟随变化）。
	PreviewPath string
}

// State 是单个窗口的可变状态。W 是宿主的窗口句柄类型（根注入
// *application.WebviewWindow）；本包从不调用它的方法，只负责存取。
type State[W any] struct {
	spec Spec
	win  W

	mu         sync.Mutex
	dirty      bool
	aiRunning  bool
	forceClose bool
	// collapsed：浮窗「收起」形态（只留标题栏）。收起期间的尺寸变化是 UI 程序化
	// 调整，不参与窗口几何记忆，避免把 44px 的标题栏高度存成用户偏好。
	collapsed bool
	// geometryApplied：创建后首次导航完成时按当前显示器收敛一次几何；后续
	// HMR/重载触发的导航不重复应用，避免把用户已拖动的窗口拉回初始位置。
	geometryApplied bool
	// shownOnce：窗口只 Show/Maximise 一次。托盘隐藏的窗口遇到 reload（HMR /
	// location.reload）时不能被 windowReady 重新弹出（审查 P2-4）。
	shownOnce      bool
	initialGeom    windowgeom.Rect
	hasInitialGeom bool
}

// Name 返回窗口名（唯一键，同时是 v3 事件的 sender）。
func (s *State[W]) Name() string { return s.spec.Name }

// Workspace 返回该窗口当前打开的工作区。
func (s *State[W]) Workspace() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec.Workspace
}

// SetWorkspace 更新该窗口当前工作区（关闭工作区传空串）。
func (s *State[W]) SetWorkspace(ws string) {
	s.mu.Lock()
	s.spec.Workspace = ws
	s.mu.Unlock()
}

// SetWindow 登记宿主窗口句柄。
func (s *State[W]) SetWindow(w W) {
	s.mu.Lock()
	s.win = w
	s.mu.Unlock()
}

// Window 返回宿主窗口句柄（未创建/已销毁时为 W 的零值）。
func (s *State[W]) Window() W {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.win
}

// Startup 返回创建时的启动上下文快照。
func (s *State[W]) Startup() Spec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec
}

// TakeSettingsPane 取出并清空「启动时要打开的设置页」（前端启动后消费一次）。
func (s *State[W]) TakeSettingsPane() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	pane := s.spec.SettingsPane
	s.spec.SettingsPane = ""
	return pane
}

// SetDirty 记录该窗口是否有未保存改动。
func (s *State[W]) SetDirty(v bool) { s.mu.Lock(); s.dirty = v; s.mu.Unlock() }

// IsDirty 报告该窗口是否有未保存改动。
func (s *State[W]) IsDirty() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.dirty }

// SetAIRunning 记录该窗口是否正在跑 AI 回合（关窗二次确认依据）。
func (s *State[W]) SetAIRunning(v bool) { s.mu.Lock(); s.aiRunning = v; s.mu.Unlock() }

// IsAIRunning 报告该窗口是否正在跑 AI 回合。
func (s *State[W]) IsAIRunning() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.aiRunning }

// ForceClosed 报告该窗口是否已被「强制关闭」流程接管（跳过确认）。
func (s *State[W]) ForceClosed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.forceClose }

// MarkForceClose 标记该窗口已被强制关闭流程接管。
func (s *State[W]) MarkForceClose() { s.mu.Lock(); s.forceClose = true; s.mu.Unlock() }

// SetCollapsed / IsCollapsed：浮窗收起形态（只留标题栏），几何采集据此跳过。
func (s *State[W]) SetCollapsed(v bool) { s.mu.Lock(); s.collapsed = v; s.mu.Unlock() }

// IsCollapsed 报告浮窗是否处于收起形态。
func (s *State[W]) IsCollapsed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.collapsed }

// SetInitialGeometry 记录创建时算好的几何（未命中存档时 ok=false）。
func (s *State[W]) SetInitialGeometry(r windowgeom.Rect, ok bool) {
	s.mu.Lock()
	s.initialGeom, s.hasInitialGeom = r, ok
	s.mu.Unlock()
}

// MarkShownOnce 首次调用返回 true；后续导航重载不再重复显示窗口。
func (s *State[W]) MarkShownOnce() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shownOnce {
		return false
	}
	s.shownOnce = true
	return true
}

// TakeInitialGeometry 首次调用返回创建时的几何并标记已应用；后续导航返回 false。
func (s *State[W]) TakeInitialGeometry() (windowgeom.Rect, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.geometryApplied {
		return windowgeom.Rect{}, false
	}
	s.geometryApplied = true
	return s.initialGeom, s.hasInitialGeom
}

// Registry 是进程内窗口集合。主窗口/浮窗/调试控制台都在这里按名字登记。
type Registry[W any] struct {
	mu     sync.RWMutex
	states map[string]*State[W]
	seq    int
}

// New 构造一个空注册表。
func New[W any]() *Registry[W] {
	return &Registry[W]{states: map[string]*State[W]{}}
}

// NextName 给新窗口分配唯一名字：首个主窗口固定 main，其余 main-2/...
func (r *Registry[W]) NextName(mode Mode) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	switch mode {
	case ModeFloat:
		if _, ok := r.states["float"]; !ok {
			return "float"
		}
		return fmt.Sprintf("float-%d", r.seq)
	case ModeDebug:
		if _, ok := r.states["debug"]; !ok {
			return "debug"
		}
		return fmt.Sprintf("debug-%d", r.seq)
	case ModeTerminal:
		if _, ok := r.states["term"]; !ok {
			return "term"
		}
		return fmt.Sprintf("term-%d", r.seq)
	case ModeMemo:
		if _, ok := r.states["memo"]; !ok {
			return "memo"
		}
		return fmt.Sprintf("memo-%d", r.seq)
	case ModeMonitor:
		if _, ok := r.states["monitor"]; !ok {
			return "monitor"
		}
		return fmt.Sprintf("monitor-%d", r.seq)
	case ModeDiff:
		if _, ok := r.states["diff"]; !ok {
			return "diff"
		}
		return fmt.Sprintf("diff-%d", r.seq)
	case ModeLight:
		if _, ok := r.states["light"]; !ok {
			return "light"
		}
		return fmt.Sprintf("light-%d", r.seq)
	case ModePreview:
		if _, ok := r.states["preview"]; !ok {
			return "preview"
		}
		return fmt.Sprintf("preview-%d", r.seq)
	default:
		if _, ok := r.states["main"]; !ok {
			return "main"
		}
		return fmt.Sprintf("main-%d", r.seq)
	}
}

// Add 登记一个新窗口状态（Spec.Name 必须已由 NextName 分配）。
func (r *Registry[W]) Add(spec Spec) *State[W] {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := &State[W]{spec: spec}
	r.states[spec.Name] = state
	return state
}

// Get 按窗口名取状态（不存在返回 nil）。
func (r *Registry[W]) Get(name string) *State[W] {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.states[name]
}

// Remove 摘除窗口状态。
func (r *Registry[W]) Remove(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.states, name)
}

// List 返回全部窗口状态（顺序不定，调用方按需排序）。
func (r *Registry[W]) List() []*State[W] {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*State[W], 0, len(r.states))
	for _, s := range r.states {
		out = append(out, s)
	}
	return out
}

// CountMain 统计仍存活的主窗口数。
func (r *Registry[W]) CountMain() int { return r.CountMode(ModeMain) }

// CountMode 统计指定形态的窗口数（几何级联与启动门控用）。
func (r *Registry[W]) CountMode(mode Mode) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n := 0
	for _, s := range r.states {
		if s.spec.Mode == mode {
			n++
		}
	}
	return n
}

// Count 统计仍存活的窗口总数（应用级服务只在最后一个窗口关闭时收口）。
func (r *Registry[W]) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.states)
}

// AnyDirty / AnyAIRunning 汇总全部窗口的标记（退出应用时把附属窗口的状态算入确认）。
func (r *Registry[W]) AnyDirty() bool {
	return r.any(func(s *State[W]) bool { return s.IsDirty() })
}

// AnyAIRunning 汇总全部窗口的 AI 回合标记。
func (r *Registry[W]) AnyAIRunning() bool {
	return r.any(func(s *State[W]) bool { return s.IsAIRunning() })
}

// any 先快照再逐个读窗口状态，避免 registry 锁与 State 锁反向嵌套。
func (r *Registry[W]) any(match func(*State[W]) bool) bool {
	r.mu.RLock()
	states := make([]*State[W], 0, len(r.states))
	for _, s := range r.states {
		states = append(states, s)
	}
	r.mu.RUnlock()
	for _, s := range states {
		if match(s) {
			return true
		}
	}
	return false
}

// FindByWorkspace 找一个开着目标工作区的主窗口（exclude 为调用方窗口名）。
func (r *Registry[W]) FindByWorkspace(workspace, exclude string) *State[W] {
	if workspace == "" {
		return nil
	}
	want := PathKey(workspace)
	r.mu.RLock()
	defer r.mu.RUnlock()
	for name, s := range r.states {
		if name == exclude || s.spec.Mode != ModeMain {
			continue
		}
		if PathKey(s.Workspace()) == want {
			return s
		}
	}
	return nil
}

// Primary 返回主窗口状态（main 优先，其次按名字序最早的主窗口；没有则 nil）。
func (r *Registry[W]) Primary() *State[W] {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if s, ok := r.states["main"]; ok {
		return s
	}
	names := make([]string, 0, len(r.states))
	for name, s := range r.states {
		if s.spec.Mode == ModeMain {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	sort.Strings(names)
	return r.states[names[0]]
}

// ---- 辅助窗口按条件查找（只读 Spec，不碰窗口 API）----

// FindMemo 按作用域找已存在的便签窗（同作用域只开一个，写权租约单写者）。
func (r *Registry[W]) FindMemo(scope, workspace string) *State[W] {
	scope = NormalizeMemoScope(scope)
	workspace = strings.TrimSpace(workspace)
	for _, st := range r.List() {
		spec := st.Startup()
		if spec.Mode != ModeMemo || spec.MemoScope != scope {
			continue
		}
		if strings.TrimSpace(spec.Workspace) != workspace {
			continue
		}
		return st
	}
	return nil
}

// FindMonitor 按会话 id 找已存在的监控窗（一个会话最多一个监控位）。
func (r *Registry[W]) FindMonitor(sessionID string) *State[W] {
	sessionID = strings.TrimSpace(sessionID)
	for _, st := range r.List() {
		spec := st.Startup()
		if spec.Mode == ModeMonitor && strings.TrimSpace(spec.SessionID) == sessionID {
			return st
		}
	}
	return nil
}

// FindDiff 按文件对找已存在的对比窗（同对只开一个，换对再开新窗）。
func (r *Registry[W]) FindDiff(left, right string) *State[W] {
	left, right = strings.TrimSpace(left), strings.TrimSpace(right)
	for _, st := range r.List() {
		spec := st.Startup()
		if spec.Mode != ModeDiff {
			continue
		}
		if strings.TrimSpace(spec.DiffLeft) == left && strings.TrimSpace(spec.DiffRight) == right {
			return st
		}
	}
	return nil
}

// FindLight 按文件路径找已存在的轻量查看窗（同文件只开一个）。
func (r *Registry[W]) FindLight(path string) *State[W] {
	path = strings.TrimSpace(path)
	for _, st := range r.List() {
		spec := st.Startup()
		if spec.Mode == ModeLight && strings.TrimSpace(spec.LightPath) == path {
			return st
		}
	}
	return nil
}

// FindPreview 按源文件路径找已存在的预览窗（一个源文件一个预览位）。
func (r *Registry[W]) FindPreview(path string) *State[W] {
	path = strings.TrimSpace(path)
	for _, st := range r.List() {
		spec := st.Startup()
		if spec.Mode == ModePreview && strings.TrimSpace(spec.PreviewPath) == path {
			return st
		}
	}
	return nil
}

// NormalizeMemoScope 校验便签作用域入参（workspace 之外的值一律 global）。
func NormalizeMemoScope(scope string) string {
	if strings.ToLower(strings.TrimSpace(scope)) == "workspace" {
		return "workspace"
	}
	return "global"
}

// NormalizeSessionKind 校验监控窗会话类型（group 之外一律 session）。
func NormalizeSessionKind(kind string) string {
	if strings.ToLower(strings.TrimSpace(kind)) == "group" {
		return "group"
	}
	return "session"
}

// PathKey 路径归一（分隔符/大小写/尾斜杠），与前端 sessionPathKey 同口径。
func PathKey(p string) string {
	out := make([]rune, 0, len(p))
	for _, r := range p {
		if r == '\\' {
			r = '/'
		}
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		out = append(out, r)
	}
	for len(out) > 0 && out[len(out)-1] == '/' {
		out = out[:len(out)-1]
	}
	return string(out)
}
