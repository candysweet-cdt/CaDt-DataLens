//go:build windows

package notify

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	toast "git.sr.ht/~jackmordaunt/go-toast/v2"
	"golang.org/x/sys/windows/registry"

	"datalens/internal/appdata"
)

// toastAppID 是系统通知的应用标识（AppUserModelID）。
//
// 换过一次：早期版本用的是 "CaDt-DataLens"，那时 IconUri 还写成 exe 路径（系统不认），
// 通知平台就把「这个 AppID 没有图标」缓存下来了——之后即使把 IconUri 改成真实 PNG，
// 同一个 AppID 也不会再刷新（实测：卡片头部始终空白），所以改成带厂商前缀的新 id。
const toastAppID = "CandySweet.CaDt-DataLens"

// toastDisplayName 是通知卡片标题行显示的应用名（注册表 AUMID 的 DisplayName）。
const toastDisplayName = "CaDt-DataLens"

// toastLegacyAppIDs 是历史上用过的 id：启动时把它们的登记与通知设置一并清掉，
// 免得到「设置 → 系统 → 通知」里看到一条永远不会有通知的幽灵条目。
var toastLegacyAppIDs = []string{"CaDt-DataLens"}

var (
	notifyUser32                 = syscall.NewLazyDLL("user32.dll")
	procNotifyEnumWindows        = notifyUser32.NewProc("EnumWindows")
	procNotifyGetWindowThreadPID = notifyUser32.NewProc("GetWindowThreadProcessId")
	procNotifyIsWindowVisible    = notifyUser32.NewProc("IsWindowVisible")
	procNotifyFlashWindowEx      = notifyUser32.NewProc("FlashWindowEx")
	procNotifyMessageBeep        = notifyUser32.NewProc("MessageBeep")
	procNotifyGetForegroundWnd   = notifyUser32.NewProc("GetForegroundWindow")
	procNotifyIsIconic           = notifyUser32.NewProc("IsIconic")
	procNotifyLoadImage          = notifyUser32.NewProc("LoadImageW")
	procNotifyGetModuleHandle    = syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW")
)

// notifyImageIcon 对应 LoadImageW 的 IMAGE_ICON。
const notifyImageIcon = 1

type flashWindowInfo struct {
	cbSize    uint32
	hwnd      uintptr
	dwFlags   uint32
	uCount    uint32
	dwTimeout uint32
}

// 一次 EnumWindows 的匹配条件与结果。回调必须是**包级静态**值：
// syscall.NewCallback 每次调用都会永久占用一个 Go runtime 回调槽（上限约 2000），
// 槽满时 runtime 直接 throw、进程消失。同仓 browser/tray 的回调都是包级变量。
var (
	notifyEnumMu     sync.Mutex
	notifyEnumPID    uint32
	notifyEnumTarget uintptr
)

var notifyAttentionCallback = syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
	var windowPID uint32
	procNotifyGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&windowPID)))
	if windowPID != notifyEnumPID {
		return 1
	}
	visible, _, _ := procNotifyIsWindowVisible.Call(hwnd)
	if visible == 0 {
		return 1
	}
	notifyEnumTarget = hwnd
	return 0
})

// NotifyAttention 让当前进程的任务栏图标闪烁（窗口已聚焦时基本无感），可选播放系统提示音。
func (nt *Notifier) NotifyAttention(beep bool) {
	notifyEnumMu.Lock()
	notifyEnumPID = uint32(os.Getpid())
	notifyEnumTarget = 0
	procNotifyEnumWindows.Call(notifyAttentionCallback, 0)
	target := notifyEnumTarget
	notifyEnumMu.Unlock()
	if target != 0 {
		info := flashWindowInfo{
			cbSize:  uint32(unsafe.Sizeof(flashWindowInfo{})),
			hwnd:    target,
			dwFlags: 0x00000003 | 0x0000000C, // FLASHW_ALL | FLASHW_TIMERNOFG
			uCount:  3,
		}
		procNotifyFlashWindowEx.Call(uintptr(unsafe.Pointer(&info)))
	}
	if beep {
		procNotifyMessageBeep.Call(0xFFFFFFFF)
	}
}

var (
	toastRegMu sync.Mutex
	toastRegOK bool
)

// ensureToastAppID 把本应用登记进 Windows 的通知系统。
//
// 这一步不能省：没有安装包（也就没有带 AppUserModelID 的开始菜单快捷方式）的桌面应用，
// 系统不认这个 AppID——CreateToastNotifier 与 Show 全都返回成功，但通知**根本不显示**，
// 调用方拿不到任何错误。这就是系统通知一直「像是开了但没反应」的根因。
//
// 在 HKCU\SOFTWARE\Classes\AppUserModelId\<AppID> 下写 DisplayName + IconUri 即被系统认作
// 已注册应用：通知能正常弹出、出现在「设置 → 系统 → 通知」的应用列表里，IconUri 即是
// 通知头部「应用名左边」那个小图标（实测确认；指向 exe 不认，必须是 ico/png 图片文件）。
// 每次启动都覆盖写一遍，应用被挪到别的目录时 IconUri 不会留在旧路径上。
func ensureToastAppID() error {
	toastRegMu.Lock()
	defer toastRegMu.Unlock()
	if toastRegOK {
		return nil
	}
	// 图标先渲染好：IconUri 指向的必须是真实存在的图片文件。
	icon := toastIconPath()
	key, _, err := registry.CreateKey(registry.CURRENT_USER,
		`SOFTWARE\Classes\AppUserModelId\`+toastAppID, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("登记通知应用标识失败：%w", err)
	}
	defer key.Close()
	if err := key.SetStringValue("DisplayName", toastDisplayName); err != nil {
		return fmt.Errorf("写入通知应用名称失败：%w", err)
	}
	// 渲染失败就不写：宁可不带图标，也不能写一个指向空文件的 IconUri。
	if icon != "" {
		_ = key.SetStringValue("IconUri", icon)
	}
	toastRegOK = true
	cleanupLegacyToastAppIDs()
	return nil
}

// cleanupLegacyToastAppIDs 删掉旧 AppID 留下的注册表项（AUMID 登记 + 通知设置）。
// 删不掉也无所谓（权限/占用），下次启动还会试。
func cleanupLegacyToastAppIDs() {
	for _, id := range toastLegacyAppIDs {
		_ = registry.DeleteKey(registry.CURRENT_USER, `SOFTWARE\Classes\AppUserModelId\`+id)
		_ = registry.DeleteKey(registry.CURRENT_USER,
			`Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\`+id)
	}
}

// AppWindowActive 报告「本进程有窗口正处在前台」。
//
// 前端用它决定要不要弹打断性通知，**不能**只信 WebView2 里的 document.hasFocus()：
// 焦点状态在嵌入场景下会滞留（明明切走了还报 true），通知就永远不弹。
// 系统级判定：前台窗口属于本进程且未被最小化；多窗口（主窗 / AI 浮窗）任一在前台都算前台。
func (nt *Notifier) AppWindowActive() bool {
	fg, _, _ := procNotifyGetForegroundWnd.Call()
	if fg == 0 {
		return false
	}
	var pid uint32
	procNotifyGetWindowThreadPID.Call(fg, uintptr(unsafe.Pointer(&pid)))
	if pid != uint32(os.Getpid()) {
		return false
	}
	iconic, _, _ := procNotifyIsIconic.Call(fg)
	return iconic == 0
}

// Prepare 启动时把本应用登记进 Windows 通知系统（见 ensureToastAppID），
// 并预先渲染通知卡片要用的图标（见 toastIconPath）、注册点击激活回调（见 registerToastActivation）。
// 失败不阻塞启动：真正要发通知时还会再试一次，并把错误返回给调用方。
func Prepare() {
	_ = ensureToastAppID()
	_ = toastIconPath()
	registerToastActivation()
}

// ---- 通知点击激活 ----
//
// 通知卡片上除了 Title/Body 还得告诉 Windows「点了我之后叫醒谁」，否则点击只等于关闭卡片：
//
//	· toast XML 的 launch 属性放业务参数（NotifySystemToast 的 payload，如 "ai-session=<id>"）；
//	· 注册表 AUMID 下写 CustomActivator 指向库内置的 COM 激活器 GUID（SetAppData 完成），
//	  再由 pushCOM 在本进程注册类工厂——应用运行期间点击通知，Windows 就把激活投递回本进程；
//	· SetActivationCallback 收到激活后转交宿主钩子 OnToastActivation（拉窗口 + 发事件给前端）。
//
// 应用完全没在跑时点旧卡片：Windows 会按 LocalServer32 拉起 exe（带 -Embedding 参数），
// 应用正常启动即可；旧通知的会话参数在冷启动场景拿不到（激活超时早过），可接受——
// 旧卡片本来就多半过期了。
func registerToastActivation() {
	toastActivationOnce.Do(func() {
		// 库的回调签名是 (args, userData)：args 即 toast XML launch 属性（invokedArgs）原文。
		toast.SetActivationCallback(func(args string, userData []toast.UserData) {
			payload := strings.TrimSpace(args)
			logf("info", "系统通知被点击，激活参数：%q", payload)
			if OnToastActivation != nil {
				OnToastActivation(payload)
			}
		})
		exe, err := os.Executable()
		if err != nil {
			logf("warn", "登记通知激活器失败（通知点击无效）：%v", err)
			return
		}
		// SetAppData 会补写 CustomActivator 与 LocalServer32；DisplayName/IconUri 我们已写过，
		// 库对已存在的值跳过写入，不会覆盖友好名。exe 被挪动后 LocalServer32 里是旧路径
		//（库对已存在值不覆盖），只影响「应用没跑时点旧卡片」的冷启动，运行期激活不走它。
		if err := toast.SetAppData(toast.AppData{AppID: toastAppID, ActivationExe: exe}); err != nil {
			logf("warn", "登记通知激活器失败（通知点击无效）：%v", err)
		}
	})
}

var toastActivationOnce sync.Once

// ---- 通知头部的应用图标 ----
//
// Windows 通知头部「应用名左边」的小图标与「设置 → 系统 → 通知」列表里的图标，都来自注册表
// AUMID 的 IconUri——而它只认 ico/png 图片文件，写成 exe 路径不生效（实测过，会变成没有图标）。
// 所以这里把 exe 里嵌的图标（rsrc 图标组 id=IconID，与任务栏同一个）渲染成一张 PNG 落到
// 应用数据目录，IconUri 指向它：不额外打包图片资源，图标改了跟着 exe 自动更新。

const toastIconSize = 48

var (
	toastIconMu   sync.Mutex
	toastIconFile string
	toastIconDone bool

	notifyIconGDI = syscall.NewLazyDLL("gdi32.dll")
	procIconDC    = notifyIconGDI.NewProc("CreateCompatibleDC")
	procIconDIB   = notifyIconGDI.NewProc("CreateDIBSection")
	procIconSel   = notifyIconGDI.NewProc("SelectObject")
	procIconDel   = notifyIconGDI.NewProc("DeleteObject")
	procIconDelDC = notifyIconGDI.NewProc("DeleteDC")

	procNotifyDrawIcon    = notifyUser32.NewProc("DrawIconEx")
	procNotifyDestroyIcon = notifyUser32.NewProc("DestroyIcon")
)

type notifyIconBitmapInfo struct {
	size          uint32
	width         int32
	height        int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPelsPerMeter int32
	yPelsPerMeter int32
	clrUsed       uint32
	clrImportant  uint32
}

// renderAppIconPNG 把 exe 里的图标资源画到 32 位位图再编码成 PNG。
// 位图用负高度（top-down）省一次翻转；DrawIconEx 会把图标的 alpha 一并写进来。
func renderAppIconPNG(dest string) error {
	hinst, _, _ := procNotifyGetModuleHandle.Call(0)
	hicon, _, _ := procNotifyLoadImage.Call(hinst, IconID, notifyImageIcon, toastIconSize, toastIconSize, 0)
	if hicon == 0 {
		return fmt.Errorf("读不到 exe 内的图标资源")
	}
	defer procNotifyDestroyIcon.Call(hicon)

	hdc, _, _ := procIconDC.Call(0)
	if hdc == 0 {
		return fmt.Errorf("创建内存 DC 失败")
	}
	defer procIconDelDC.Call(hdc)

	info := notifyIconBitmapInfo{
		size:        uint32(unsafe.Sizeof(notifyIconBitmapInfo{})),
		width:       toastIconSize,
		height:      -toastIconSize, // 负数 = top-down
		planes:      1,
		bitCount:    32,
		compression: 0, // BI_RGB
	}
	var bits unsafe.Pointer
	hbm, _, _ := procIconDIB.Call(hdc, uintptr(unsafe.Pointer(&info)), 0,
		uintptr(unsafe.Pointer(&bits)), 0, 0)
	if hbm == 0 || bits == nil {
		return fmt.Errorf("创建位图失败")
	}
	old, _, _ := procIconSel.Call(hdc, hbm)
	procNotifyDrawIcon.Call(hdc, 0, 0, hicon, toastIconSize, toastIconSize, 0, 0, 0x0003) // DI_NORMAL
	procIconSel.Call(hdc, old)
	defer procIconDel.Call(hbm)

	raw := unsafe.Slice((*byte)(bits), toastIconSize*toastIconSize*4)
	img := image.NewNRGBA(image.Rect(0, 0, toastIconSize, toastIconSize))
	for i := 0; i < len(raw); i += 4 {
		img.Pix[i] = raw[i+2]   // R
		img.Pix[i+1] = raw[i+1] // G
		img.Pix[i+2] = raw[i]   // B
		img.Pix[i+3] = raw[i+3] // A
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// toastIconPath 返回通知卡片图标的 PNG 绝对路径；渲染失败返回空串（此时只是没图标，通知照发）。
// 每次启动重渲染一次，程序换了图标不会停留在旧图上。
func toastIconPath() string {
	toastIconMu.Lock()
	defer toastIconMu.Unlock()
	if toastIconDone {
		return toastIconFile
	}
	toastIconDone = true
	root := appdata.Root()
	if root == "" {
		return ""
	}
	dest := filepath.Join(root, "notify-icon.png")
	if err := renderAppIconPNG(dest); err != nil {
		return ""
	}
	toastIconFile = dest
	return dest
}

// toastDisabledByUser 判断用户是否在「设置 → 系统 → 通知」里关掉了本应用的通知。
// 关掉之后系统同样静默丢弃，返个错总比让调用方以为发出去了要好。
func toastDisabledByUser() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\`+toastAppID, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetIntegerValue("Enabled")
	return err == nil && value == 0
}

// NotifySystemToast 发送 Windows 系统级 Toast 通知；silent=true 时不播放系统提示音。
// payload 是点击通知时回传给激活回调（OnToastActivation）的参数，如 "ai-session=<id>"；可为空。
func (nt *Notifier) NotifySystemToast(title string, body string, payload string, silent bool) error {
	title = strings.TrimSpace(title)
	body = strings.TrimSpace(body)
	if title == "" {
		title = toastDisplayName
	}
	if err := ensureToastAppID(); err != nil {
		return err
	}
	if toastDisabledByUser() {
		return fmt.Errorf("本应用的系统通知已在 Windows 设置里关闭")
	}
	// 不要设 Notification.Icon：那是 appLogoOverride（贴正文左侧的 48×48 大图），
	// 与系统通知「应用名左边的小图标」不是一回事；后者由 IconUri 提供。
	n := toast.Notification{
		AppID:               toastAppID,
		Title:               title,
		Body:                body,
		ActivationArguments: strings.TrimSpace(payload),
	}
	if silent {
		n.Audio = toast.Silent
	} else {
		n.Audio = toast.Default
	}
	if err := n.Push(); err != nil {
		return fmt.Errorf("系统通知失败：%w", err)
	}
	return nil
}
