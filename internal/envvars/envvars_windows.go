//go:build windows

package envvars

// DPAPI 的实际加解密在 internal/dpapi（与 AI 配置共用同一份 syscall 实现）：
// 本文件只保留 envvars 这层的命名与语义——加密失败返回错误、解密失败返回空串。

import "datalens/internal/dpapi"

const envDPAPIDescription = "CaDt-DataLens 环境变量"

// envEncryptionSupported 报告当前平台支持加密存储（Windows DPAPI）。
func envEncryptionSupported() bool { return dpapi.Supported() }

// envProtectValue 加密一个明文值，返回 base64 密文。
func envProtectValue(plain string) (string, error) {
	return dpapi.Protect(plain, envDPAPIDescription)
}

// envUnprotectValue 解密一个 base64 密文；失败（换机器/换用户/数据损坏）返回错误，
// 由调用方 fail-closed 处理（保留原密文，绝不把值抹成空串）。
func envUnprotectValue(stored string) (string, error) {
	return dpapi.Unprotect(stored)
}
