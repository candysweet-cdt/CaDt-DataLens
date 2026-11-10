//go:build !windows

package main

// runInstallerCommand 非 Windows 平台没有安装包集成，忽略这些参数。
func runInstallerCommand(args []string) bool {
	return false
}
