//go:build windows

// Package shellexec：用系统默认关联程序打开文件或目录（等价于在资源管理器里双击）。
// 标签页与文件树的右键「用默认应用打开」共用；不经过命令行，因此不会闪黑窗，
// 也不受路径里空格/中文的影响。
package shellexec

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	swShowNormal = 1
	// ShellExecuteW 的返回值 > 32 才算成功，其余是旧式 ShellExecute 错误码
	// （0/2/3/5/31/32 分别代表资源不足/找不到文件/路径不存在/拒绝访问/无关联/找不到 DLL）。
	minShellExecuteSuccess = 32
)

var shellExecuteW = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")

// Open 用默认关联程序打开路径。目录会打开资源管理器；没有关联程序时返回可读错误，
// 由调用方提示用户，不静默失败。
func Open(path string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	ret, _, callErr := shellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(target)),
		0, // 参数
		0, // 工作目录：跟随目标文件
		swShowNormal,
	)
	if ret > minShellExecuteSuccess {
		return nil
	}
	switch ret {
	case 2:
		return fmt.Errorf("文件不存在：%s", path)
	case 3:
		return fmt.Errorf("路径不存在：%s", path)
	case 5:
		return fmt.Errorf("没有权限打开：%s", path)
	case 31, 32:
		return fmt.Errorf("系统里没有能打开该文件的默认应用：%s", path)
	}
	if callErr != nil && callErr != windows.ERROR_SUCCESS {
		return fmt.Errorf("无法用默认应用打开：%w", callErr)
	}
	return fmt.Errorf("无法用默认应用打开（ShellExecute 返回 %d）：%s", ret, path)
}

// RevealInFolder 在系统文件管理器里打开目录，或在其中选中文件（等价于右键「在文件夹中显示」）。
// 路径先归一成 Windows 原生分隔符：explorer.exe 把 / 开头的段当命令行开关解析，解析失败
// 不报错，而是静默回退打开「文档」文件夹（见 TestRevealArgsUseNativePath）。
//
// 注意：这里刻意不调用 executil.HideCommandWindow。explorer.exe 是 GUI 程序，本身不会闪黑窗；
// HideWindow(SW_HIDE)/CREATE_NO_WINDOW 会把要打开的资源管理器窗口一并隐藏——进程启动成功、
// 不报错，但窗口不出现，表现为「点了没反应」。2026-11-23 下沉时误加该调用导致所有入口失效。
func RevealInFolder(path string, isDir bool) error {
	cmd := exec.Command("explorer.exe", revealArgs(path, isDir)...)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// revealArgs 构造 explorer.exe 的参数：目录直接打开，文件走 /select, 选中。
// filepath.Clean 把前端传来的正斜杠路径归一成 Windows 原生形式（关键，见上）。
func revealArgs(path string, isDir bool) []string {
	cleaned := filepath.Clean(path)
	if isDir {
		return []string{cleaned}
	}
	return []string{"/select,", cleaned}
}
