package main

import (
	"os/exec"
	"syscall"
)

// hideCommandWindow 避免 GUI 进程拉起控制台子进程时闪出黑窗。
func hideCommandWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
