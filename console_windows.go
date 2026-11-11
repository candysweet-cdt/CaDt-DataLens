package main

import (
	"os"

	"golang.org/x/sys/windows"
)

var (
	procAttachConsole       = kernel32.NewProc("AttachConsole")
	attachParentConsoleFlag = uintptr(0xFFFFFFFF) // ATTACH_PARENT_PROCESS
)

func bindStdHandle(handle uint32, name string) *os.File {
	h, err := windows.GetStdHandle(handle)
	if err != nil || h == 0 || h == windows.InvalidHandle {
		return nil
	}
	return os.NewFile(uintptr(h), name)
}

// attachParentConsole 让 GUI 子系统进程在命令行启动时能向父控制台/管道输出。
// 已存在的重定向句柄优先保留，不能因为 AttachConsole 覆盖掉管道/文件重定向。
func attachParentConsole() {
	out := bindStdHandle(windows.STD_OUTPUT_HANDLE, "stdout")
	errOut := bindStdHandle(windows.STD_ERROR_HANDLE, "stderr")
	if out != nil {
		os.Stdout = out
	}
	if errOut != nil {
		os.Stderr = errOut
	}
	if out != nil && errOut != nil {
		return
	}
	_, _, _ = procAttachConsole.Call(attachParentConsoleFlag)
	if out == nil {
		if f := bindStdHandle(windows.STD_OUTPUT_HANDLE, "stdout"); f != nil {
			os.Stdout = f
		}
	}
	if errOut == nil {
		if f := bindStdHandle(windows.STD_ERROR_HANDLE, "stderr"); f != nil {
			os.Stderr = f
		}
	}
}
