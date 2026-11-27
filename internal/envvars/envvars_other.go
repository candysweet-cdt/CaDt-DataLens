//go:build !windows

package envvars

// 非 Windows 平台没有 DPAPI：环境变量值仅支持明文存储（encrypted 恒为 false，
// envProtectValue/envUnprotectValue 不会被实际调用）。判定与实现都在 internal/dpapi。

import "datalens/internal/dpapi"

// envEncryptionSupported 报告当前平台支持加密存储。
func envEncryptionSupported() bool { return dpapi.Supported() }

// envProtectValue 明文直通（encrypted 恒为 false，不会调用）。
func envProtectValue(plain string) (string, error) {
	return dpapi.Protect(plain, "CaDt-DataLens 环境变量")
}

// envUnprotectValue 明文直通；解不开（来自加密文件的密文）返回错误，由调用方 fail-closed。
func envUnprotectValue(stored string) (string, error) {
	return dpapi.Unprotect(stored)
}
