# 关闭窗口时：最小化到托盘 / 直接退出（2026-11-18 实施）

## 1. 背景

设置里缺一个「点 X 算不算退出」的开关。对这类工具，用户经常希望：关掉窗口 ≠ 结束程序——
AI 正在跑长任务、终端里有命令、后台作业还在跑，手贱关了窗口全没了（现有实现会弹确认框，
但用户真正想要的是「别问我，收起来就好」）。

## 2. 决策

**做：`exit`（默认，行为不变）/ `tray`（点 X 只隐藏窗口）二选一 + 通知区图标。**

- **不做「只隐藏、不显示图标」**：藏起来又没有找回来的入口，等于把程序变成任务管理器里的孤儿。
  通知区图标是唯一自洽的「最小化到后台」形态，同时提供退出入口。
- **不引第三方托盘库**：项目取向是「单 exe、零依赖、系统提供引擎」。`Shell_NotifyIcon` +
  一个隐藏消息窗口 + 右键菜单，全部走 `user32` / `shell32` 的 syscall，约 400 行。
- **不用 Wails 的 `HideWindowOnClose`**：它只做「隐藏」这一半，没有图标、没有恢复入口，
  也不区分主窗口与非主窗口，更拦不住真退出。
- **不做「关闭时最小化到任务栏」**：那是系统最小化按钮的语义，与 X 重复，没有新价值。

## 3. 实现

| 位置 | 职责 |
| --- | --- |
| `internal/tray/tray_windows.go` | 独立 `LockOSThread` 的托盘线程：注册窗口类、`CreateWindowExW` 隐藏消息窗口、`GetMessage` 循环、`Shell_NotifyIconW` 加/删图标、`TrackPopupMenu` 右键菜单；`TaskbarCreated` 重挂图标 |
| `internal/tray/tray_other.go` | 非 Windows 空桩（`Supported() == false`），宿主据此关掉这条路 |
| `app_close_action.go` | `shouldHideOnClose` 唯一判定、`GetCloseAction` / `SetCloseAction` / `QuitApp` 绑定、`hideToTray` / `restoreFromTray` / `quitFromTray` / `stopTray` |
| `app_window.go` | `beforeClose` 最前面加隐藏分支；真正退出的两条出口调 `stopTray` |
| `trayhost_windows.go` / `trayhost_other.go` | 平台接缝：托盘图标编号（复用 exe 图标组 `appIconID`）、`SM_SHUTTINGDOWN` 探测 |
| `internal/appconfig` | `config.json` 新增 `closeAction`（`ask` / `exit` / `tray`，默认 `ask`，非法值回落 `exit`） |
| 前端 | 设置页「关闭窗口时」下拉 + `settings.closeAction` + `syncCloseAction`（复用 openMode 那套「前端改 → 后端落盘」）；`exitApp` 改走 `QuitApp`；启动时 `GetCloseAction` 回读覆盖本机 localStorage |

> 2026-11-29 追加 `ask`（每次询问，默认值）：点 X 弹三选一（取消 / 退出应用 / 最小化到托盘），
> 勾选「不再询问」把选择写回 `closeAction`。判定见下表新增的 ask 行；前端对话框 `#dlg-close-confirm`
> 与绑定 `MinimizeToTray` 是这次新增的落点。

### 3.1 判定表（`shouldHideOnClose`）

| action | 主窗口 | forceClose | 显式退出 | 系统关机 | 结果 |
| --- | --- | --- | --- | --- | --- |
| ask | 是 | 否 | 否 | 否 | **弹三选一**（`close-choice` 事件）：取消 / 退出应用（`ForceQuitAll`）/ 最小化到托盘（`MinimizeToTray`） |
| ask | 否 / 强制 / 关机 | — | — | — | 回落 exit 分支（附属窗口与关机不能弹框卡住） |
| exit / 空 | 任意 | 任意 | 任意 | 任意 | 退出 |
| tray | 否 | — | — | — | 退出（多窗口 / 浮窗 / 调试台） |
| tray | 是 | 是 | — | — | 退出（强制关闭） |
| tray | 是 | 否 | 是 | — | 退出（菜单 / 托盘「退出」） |
| tray | 是 | 否 | 否 | 是 | 退出（关机不能等我们） |
| tray | 是 | 否 | 否 | 否 | **隐藏到托盘** |

「主窗口」只认启动参数：`--new-window` 开出的窗口（多窗口、AI 浮窗、调试控制台）都不是主窗口。

### 3.2 找回窗口的三条路

1. 通知区图标左键单击 / 双击 → `restoreFromTray`（撤图标 + `WindowShow`）；
2. 再点一次桌面图标 → 单实例锁把参数转给现有进程 → `secondInstance` → `secondInstanceShow`；
3. 点 AI 的系统通知 → `onToastActivation` → `secondInstanceShow`。

三条路都会顺手撤掉托盘图标：窗口在前台就不该继续占通知区。

### 3.3 线程与句柄

`Shell_NotifyIcon` 的回调消息只会投递到「创建图标的那个线程的消息循环」，所以托盘线程自己建窗口、
自己跑 `GetMessage`。其它 goroutine（隐藏 / 恢复 / 退出）一律 `PostMessage` 让托盘线程去动
`HICON` 与 `visible`，不跨线程碰句柄；`hwnd` 用 `atomic.Uintptr` 发布。

## 4. 风险与边界

- **藏起来的窗口里弹确认框 = 看不见**：托盘「退出」与被系统通知唤回都会先把窗口 `WindowShow`，
  再走确认流程（`quitFromTray` 里顺序很关键）。
- **关机不能藏**：`SM_SHUTTINGDOWN` 为真时直接走退出，否则用户看到的是「关不掉」。
- **隐藏期间 AI 需要用户拍板**：审批 / 提问走系统通知（`AppWindowActive` 在窗口隐藏时为假），
  点通知即唤回窗口，不会静默卡住。
- **图标句柄**：`LoadImage` 拿到的 `HICON` 自己 `DestroyIcon`；退回系统共享图标时不销毁。
- **非 Windows**：`Supported() == false`，`beforeClose` 里的隐藏分支不生效（设置项仍显示，
  选了也只是落盘）。

## 5. 验收

- `go test .` / `go test ./internal/appconfig/` / `go test ./internal/tray/` 全绿；
- `GOOS=linux`、`GOOS=darwin` 交叉 `go vet ./...` 通过（平台接缝成对）；
- 全量前端测试与 `npm run build` 通过；
- 手工：设置 → 通用 → 关闭窗口时 = 最小化到托盘 → 点 X，窗口与任务栏按钮消失、通知区出现图标、
  弹出一次「已最小化到托盘」；点图标恢复；再点 X → 右键图标「退出」→ 弹未保存确认 → 退出；
  菜单「退出」在托盘模式下同样是真退出；`config.json` 的 `closeAction` 随设置变化。
