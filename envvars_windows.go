//go:build windows

package main

// DPAPI（CryptProtectData/CryptUnprotectData）加密环境变量值：绑定当前用户与本机，
// 配置文件拷到其他机器或换用户都无法解出明文。

import (
	"encoding/base64"
	"fmt"
	"syscall"
	"unsafe"
)

var (
	envCrypt32                = syscall.NewLazyDLL("crypt32.dll")
	procEnvCryptProtectData   = envCrypt32.NewProc("CryptProtectData")
	procEnvCryptUnprotectData = envCrypt32.NewProc("CryptUnprotectData")
)

const envDPAPIDescription = "CaDt-DataLens 环境变量"

type envDataBlob struct {
	cbData uint32
	pbData *byte
}

// envEncryptionSupported 报告当前平台支持加密存储（Windows DPAPI）。
func envEncryptionSupported() bool { return true }

func envBlobFromBytes(data []byte) envDataBlob {
	if len(data) == 0 {
		return envDataBlob{}
	}
	return envDataBlob{cbData: uint32(len(data)), pbData: &data[0]}
}

func envBlobBytes(b envDataBlob) []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	return unsafe.Slice(b.pbData, int(b.cbData))
}

// envProtectValue 加密一个明文值，返回 base64 密文。
func envProtectValue(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	in := envBlobFromBytes([]byte(plain))
	desc, err := syscall.UTF16PtrFromString(envDPAPIDescription)
	if err != nil {
		return "", err
	}
	var out envDataBlob
	r, _, callErr := procEnvCryptProtectData.Call(
		uintptr(unsafe.Pointer(&in)),
		uintptr(unsafe.Pointer(desc)),
		0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return "", fmt.Errorf("DPAPI 加密失败：%v", callErr)
	}
	defer func() {
		if out.pbData != nil {
			_, _, _ = procEnvLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
		}
	}()
	return base64.StdEncoding.EncodeToString(envBlobBytes(out)), nil
}

// envUnprotectValue 解密一个 base64 密文；失败（换机器/换用户/数据损坏）返回空串。
func envUnprotectValue(stored string) string {
	if stored == "" {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(stored)
	if err != nil {
		return ""
	}
	in := envBlobFromBytes(raw)
	var out envDataBlob
	r, _, _ := procEnvCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return ""
	}
	defer func() {
		if out.pbData != nil {
			_, _, _ = procEnvLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
		}
	}()
	return string(envBlobBytes(out))
}

var procEnvLocalFree = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
