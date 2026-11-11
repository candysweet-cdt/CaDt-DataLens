//go:build !windows

package main

import "errors"

func watchDirectory(root string, stop <-chan struct{}, emit func(paths []string, overflow bool)) error {
	return errors.New("当前平台不支持文件系统通知")
}
