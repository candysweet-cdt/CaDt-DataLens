//go:build !windows

package main

// clipboardImageDataURL 只在 Windows 上实现了系统剪贴板图片读取；
// 其它平台返回空串，前端会退回到纯文本粘贴。
func clipboardImageDataURL() (string, error) {
	return "", nil
}
