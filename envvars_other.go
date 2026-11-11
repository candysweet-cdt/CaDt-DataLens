//go:build !windows

package main

// 非 Windows 平台没有 DPAPI：环境变量值仅支持明文存储（encrypted 恒为 false，
// envProtectValue/envUnprotectValue 不会被实际调用）。

// envEncryptionSupported 报告当前平台支持加密存储。
func envEncryptionSupported() bool { return false }

// envProtectValue 明文直通（encrypted 恒为 false，不会调用）。
func envProtectValue(plain string) (string, error) { return plain, nil }

// envUnprotectValue 明文直通；来自加密文件的密文会原样返回（无法解密）。
func envUnprotectValue(stored string) string { return stored }
