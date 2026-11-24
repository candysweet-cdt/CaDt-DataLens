package main

// window_geometry.go：窗口位置/尺寸记忆（浮窗行为工程化的第一块）。
//
// 窗口角色（main / float / debug）各记一份还原矩形：移动/缩放经 500ms 防抖落盘，
// 关窗与退出时同步 flush。创建窗口时按当前显示器布局收敛，拔掉显示器或改分辨率后
// 不会落在屏幕外；额外主窗口（main-2/…）不单独持久化，从 main 的还原矩形级联，
// 避免叠在同一位置。
//
// 角色而不是窗口名做 key：窗口名随打开顺序变化（main-2 这次是第二个窗口，下次
// 可能是另一个工作区），按名字存会让位置在重启后错位。

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"datalens/internal/windowgeom"
)

const (
	// windowGeometrySaveDelay：拖拽/缩放停止后多久落盘（移动事件本身已有 50ms 防抖）。
	windowGeometrySaveDelay = 500 * time.Millisecond
	// windowCascadeStep：额外主窗口相对上一扇的错位。
	windowCascadeStep = 28
)

type windowGeometryManager struct {
	once  sync.Once
	store *windowgeom.Store

	mu    sync.Mutex
	timer *time.Timer
	dirty bool
}

var winGeom = &windowGeometryManager{}

// stateStore 懒加载 window-state.json（应用数据目录不可用时退化为纯内存）。
func (g *windowGeometryManager) stateStore() *windowgeom.Store {
	g.once.Do(func() {
		path := ""
		if root := appDataRoot(); root != "" {
			path = filepath.Join(root, "window-state.json")
		}
		g.store = windowgeom.Load(path)
	})
	return g.store
}

// screenWorkAreas 返回当前显示器工作区（物理像素）与主屏工作区。
func screenWorkAreas() (areas []windowgeom.Rect, primary windowgeom.Rect) {
	if wailsApp == nil || wailsApp.Screen == nil {
		return nil, windowgeom.Rect{}
	}
	for _, s := range wailsApp.Screen.GetAll() {
		if s == nil {
			continue
		}
		areas = append(areas, screenWorkArea(s))
	}
	if p := wailsApp.Screen.GetPrimary(); p != nil {
		primary = screenWorkArea(p)
	}
	if !primary.Valid() && len(areas) > 0 {
		primary = areas[0]
	}
	return areas, primary
}

func screenWorkArea(s *application.Screen) windowgeom.Rect {
	if s == nil {
		return windowgeom.Rect{}
	}
	// v3 的窗口 Position/Size 是 DIP 逻辑坐标（Windows 实现里 PhysicalToDipRect），
	// 工作区必须同空间取 WorkArea；PhysicalWorkArea 是物理像素，混用会在
	// 非 100% 缩放 / 混合 DPI 下把窗口夹到屏幕外（2026-11-21 审查 P1-1）。
	wa := s.WorkArea
	return windowgeom.Rect{X: wa.X, Y: wa.Y, Width: wa.Width, Height: wa.Height}
}

// geometryRestoreKey / geometryPersistKey 只是转调：key 规则在
// internal/windowgeom/keys.go（纯函数，测试随包）。保留薄包装是为了让窗口族
// 的调用点不必在 Mode 与字符串之间来回转换。
func geometryRestoreKey(spec windowSpec, modeCount int) (string, int) {
	return windowgeom.RestoreKey(string(spec.Mode), spec.Name, modeCount)
}

func geometryPersistKey(spec windowSpec, isPrimary bool) string {
	return windowgeom.PersistKey(string(spec.Mode), spec.Name, isPrimary)
}

// initialGeometry 计算窗口创建时应使用的矩形。ok=false 时保持 v3 默认居中。
func (g *windowGeometryManager) initialGeometry(spec windowSpec, defaultW, defaultH, minW, minH int) (windowgeom.Rect, bool) {
	key, cascade := geometryRestoreKey(spec, winReg.CountMode(spec.Mode))
	if key == "" {
		return windowgeom.Rect{}, false
	}
	areas, primary := screenWorkAreas()
	saved, ok := g.stateStore().Get(key)
	if !ok {
		if cascade == 0 {
			// 首次运行：沿用默认居中，等第一次移动/关闭时再记下来。
			return windowgeom.Rect{}, false
		}
		if !primary.Valid() {
			return windowgeom.Rect{}, false
		}
		base := windowgeom.Center(defaultW, defaultH, primary)
		r := windowgeom.Offset(base, cascade*windowCascadeStep, cascade*windowCascadeStep)
		return windowgeom.Normalize(r, minW, minH, areas, primary), true
	}

	// 最大化只对主窗口角色有意义；级联出来的窗口一律以普通尺寸出现。
	if cascade > 0 {
		saved.Maximised = false
	}
	r := windowgeom.Offset(saved, cascade*windowCascadeStep, cascade*windowCascadeStep)
	return windowgeom.Normalize(r, minW, minH, areas, primary), true
}

// capture 把当前窗口几何写进内存并安排落盘；最小化/全屏/最大化时保留还原矩形。
func (g *windowGeometryManager) capture(st *windowState) {
	if st == nil {
		return
	}
	spec := st.Startup()
	key := geometryPersistKey(spec, winReg.Primary() == st)
	if key == "" {
		return
	}
	w := st.Window()
	if w == nil || w.IsMinimised() || w.IsFullscreen() {
		return
	}
	// 浮窗「收起」时窗口被 UI 压到标题栏高度；这不是用户偏好，跳过采集，
	// 保留收起前的还原矩形（下次打开仍是展开后的大小）。
	if st.IsCollapsed() {
		return
	}
	// 创建阶段的初始定位/尺寸事件会早于 windowReady 到达。此时窗口还不可见，
	// 采集会把「最大化」标记冲成普通状态（重启后就不还原最大化了），直接跳过；
	// 用户真正拖动/缩放时窗口必然可见。
	if !w.IsVisible() {
		return
	}

	var r windowgeom.Rect
	if w.IsMaximised() {
		// 最大化时的 Position/Size 是屏幕尺寸，不能当还原矩形；只置标记。
		prev, ok := g.stateStore().Get(key)
		if !ok || !prev.Valid() {
			// 首次运行没移动过就最大化：按默认尺寸在主屏居中合成一条还原记录，
			// 否则「未移动直接最大化」的偏好永远记不下来（2026-11-21 审查 P2-3）。
			_, primary := screenWorkAreas()
			if !primary.Valid() {
				return
			}
			defW, defH, _, _ := windowSizesFor(spec.Mode)
			r = windowgeom.Center(defW, defH, primary)
		} else {
			r = prev
		}
		r.Maximised = true
	} else {
		x, y := w.Position()
		width, height := w.Size()
		if width <= 0 || height <= 0 {
			return
		}
		r = windowgeom.Rect{X: x, Y: y, Width: width, Height: height}
	}
	if g.stateStore().Put(key, r) {
		g.scheduleSave()
	}
}

func (g *windowGeometryManager) scheduleSave() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.dirty = true
	if g.timer != nil {
		g.timer.Stop()
	}
	g.timer = time.AfterFunc(windowGeometrySaveDelay, func() {
		g.mu.Lock()
		g.timer = nil
		dirty := g.dirty
		g.dirty = false
		g.mu.Unlock()
		if dirty {
			g.save()
		}
	})
}

// flush 立即落盘（关窗/退出时调用）；没有变化时是空操作。
func (g *windowGeometryManager) flush() {
	g.mu.Lock()
	if g.timer != nil {
		g.timer.Stop()
		g.timer = nil
	}
	dirty := g.dirty
	g.dirty = false
	g.mu.Unlock()
	if dirty {
		g.save()
	}
}

func (g *windowGeometryManager) save() {
	if err := g.stateStore().Save(); err != nil {
		writeAppLog("warn", "窗口几何落盘失败：%v", err)
	}
}

// installGeometryHooks 给窗口挂几何采集钩子。v3 在 Windows 上发的是
// events.Windows.*（WindowDidMove 自带 50ms 防抖），最大化/还原也采集一次，
// 保证「最大化后关窗」能记住还原矩形。
func installGeometryHooks(win *application.WebviewWindow, st *windowState) {
	if win == nil || st == nil {
		return
	}
	capture := func(_ *application.WindowEvent) { winGeom.capture(st) }
	win.RegisterHook(events.Windows.WindowDidMove, capture)
	win.RegisterHook(events.Windows.WindowDidResize, capture)
	win.RegisterHook(events.Windows.WindowMaximise, capture)
	win.RegisterHook(events.Windows.WindowUnMaximise, capture)
}

// ---- 显示器布局看护（拔屏 / 改分辨率的运行期收敛） ----

const (
	// screenWatchInterval：布局轮询周期。v3 在 WM_DISPLAYCHANGE 时自己刷新 ScreenManager
	// 缓存，这里只负责发现「布局变了」这件事——轮询比挂 Win32 钩子省事且足够。
	screenWatchInterval = 10 * time.Second
	// screenWatchSettle：布局变化后等系统排完窗口再收敛（Windows 会自动搬窗口）。
	screenWatchSettle = 1500 * time.Millisecond
)

func screenAreasSignature(areas []windowgeom.Rect) string {
	parts := make([]string, 0, len(areas))
	for _, a := range areas {
		parts = append(parts, fmt.Sprintf("%d,%d,%d,%d", a.X, a.Y, a.Width, a.Height))
	}
	return strings.Join(parts, "|")
}

// startScreenWatch 启动显示器布局看护：布局变化后把可见窗口按新布局收敛一次
// （只平移不缩放，见 windowgeom.ClampVisible）。不还原最大化/全屏/收起态的窗口。
func (a *App) startScreenWatch() {
	go func() {
		last := ""
		for {
			time.Sleep(screenWatchInterval)
			if wailsApp == nil || wailsApp.Screen == nil {
				continue
			}
			areas, _ := screenWorkAreas()
			sig := screenAreasSignature(areas)
			if sig == last {
				continue
			}
			first := last == ""
			last = sig
			if first {
				continue // 首轮只记基线
			}
			time.Sleep(screenWatchSettle)
			a.reclampVisibleWindows()
		}
	}()
}

// reclampVisibleWindows 把可见窗口按当前显示器布局收敛（启动收敛的运行期补充）。
func (a *App) reclampVisibleWindows() {
	areas, primary := screenWorkAreas()
	if len(areas) == 0 {
		return
	}
	for _, st := range winReg.List() {
		w := st.Window()
		if w == nil || !w.IsVisible() || w.IsMinimised() || w.IsMaximised() || w.IsFullscreen() {
			continue
		}
		if st.IsCollapsed() {
			continue
		}
		x, y := w.Position()
		width, height := w.Size()
		cur := windowgeom.Rect{X: x, Y: y, Width: width, Height: height}
		fixed := windowgeom.ClampVisible(cur, areas, primary)
		if !fixed.Valid() || fixed == cur {
			continue
		}
		w.SetPosition(fixed.X, fixed.Y)
		w.SetSize(fixed.Width, fixed.Height)
		writeAppLog("info", "显示器布局变化：窗口 %s 收敛到 (%d,%d) %dx%d", st.Name(), fixed.X, fixed.Y, fixed.Width, fixed.Height)
	}
}
