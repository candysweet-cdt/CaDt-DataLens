package browser

// 浏览器使用标签页：内容区内嵌 WebView2（browser-use）。
// Windows 实现在 browser_windows.go / browser_com_windows.go，其余平台为 stub。
// 每个 AI 会话可通过 profileKey 获得独立的用户数据目录（cookie/登录态隔离）。

import (
	"context"
	"regexp"
)

// Host 内嵌浏览器引擎。Windows 下持有 WebView2 宿主线程；其余平台为 stub。
type Host struct{}

// 宿主注入（main 包的根壳在 init/startup 接线）。
var (
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
	// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
	Emit func(event string, data any)
	// FindParent 返回 WebView2 控件的兜底宿主父窗口（根 platform_windows.go 的
	// findWailsWindow）。v3 一进程多窗口后只在拿不到调用方窗口时兜底（测试/非绑定路径）。
	FindParent func() uintptr
	// ParentForCall 返回绑定调用方窗口的原生句柄（main 用 callerWindow+NativeWindow）。
	// 浏览器控件归属发起它的窗口——不再按 Z 序猜「当前主窗口」。
	ParentForCall func(ctx context.Context) uintptr
)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

func emit(event string, data any) {
	if Emit != nil {
		Emit(event, data)
	}
}

const browserMaxInstances = 4

// ProfileRoot 内嵌浏览器每个实例的 WebView2 用户数据根目录名（在应用数据目录下）。
// 关掉标签页不会回收这些目录，「存储与清理」按它列出可清除的实例数据（见 storage_app.go）。
const ProfileRoot = "BrowserSessions"

var browserProfileKeyRule = regexp.MustCompile(`[^A-Za-z0-9_\-]`)

// sanitizeBrowserProfileKey 把 profileKey 清洗成安全的目录名片段。
func sanitizeBrowserProfileKey(key string) string {
	cleaned := browserProfileKeyRule.ReplaceAllString(key, "_")
	if len(cleaned) > 64 {
		cleaned = cleaned[:64]
	}
	return cleaned
}

// browserNewWindowGuardScript 在每个页面文档创建时、页面自身脚本之前注入：
// 把「开新窗口」请求统一改为当前标签页内跳转。WebView2 遇到 target=_blank 链接
// 或 window.open 时默认会弹出一个脱离应用 UI 的原生浮动窗口（带系统标题栏/地址栏），
// 与内嵌标签页体验割裂。底层 edge.Chromium 封装未暴露 NewWindowRequested 回调，
// 且项目有过 COM 回调 panic 闪退的教训，故用初始化脚本在 DOM/JS 层拦截，改动最小。
//
// 注意取舍：覆盖 window.open 会让依赖弹窗做功能的页面改为页内跳转；对内嵌浏览器
// 而言这是期望行为（原生弹窗本就不受应用控制），因此接受。
const browserNewWindowGuardScript = `;(function(){
'use strict';
// 1) JS 主动开新窗口：改为当前页跳转
try {
  window.open = function(u){
    if(u){ window.location.href = String(u); }
    return null;
  };
} catch(e){}
// 2) 把 a/area/form 的 target=_blank（及别名）改成 _self，捕获阶段早于页面 handler
function __cadtRetarget(el){
  try {
    if(!el || !el.getAttribute) return;
    var t = (el.getAttribute('target')||'').toLowerCase();
    if(t === '_blank' || t === '_new' || t === 'new') el.setAttribute('target','_self');
  } catch(e){}
}
document.addEventListener('click', function(e){
  try {
    var n = e.target;
    if(n && n.closest){
      var a = n.closest('a[target],area[target]');
      if(a) __cadtRetarget(a);
    }
  } catch(e){}
}, true);
document.addEventListener('submit', function(e){ __cadtRetarget(e.target); }, true);
})();`
