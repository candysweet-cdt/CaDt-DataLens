//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows/registry"
)

func TestCommandHelpers(t *testing.T) {
	if got := commandFor(`C:\Tools\CaDt-DataLens.exe`, "%1"); got != `"C:\Tools\CaDt-DataLens.exe" "%1"` {
		t.Fatalf("commandFor = %q", got)
	}
	if !commandMatches(`"C:\Tools\CaDt-DataLens.exe" "%1"`, `C:\Tools\CaDt-DataLens.exe`) {
		t.Fatal("commandMatches should match the executable")
	}
	if commandMatches(`"C:\Other\app.exe" "%1"`, `C:\Tools\CaDt-DataLens.exe`) {
		t.Fatal("commandMatches matched a different executable")
	}
}

func TestIntegrationStatusReadable(t *testing.T) {
	status, err := NewApp().GetIntegrationStatus()
	if err != nil {
		t.Fatal(err)
	}
	if status.Executable == "" {
		t.Fatal("empty executable path")
	}
}

func TestRegistryHelpersRoundTrip(t *testing.T) {
	root := `Software\CaDt-DataLensTest`
	_ = deleteKeyTree(root)
	defer deleteKeyTree(root)

	path := root + `\nested\child`
	if err := setString(path, "", "value"); err != nil {
		t.Fatal(err)
	}
	if got := readDefault(path); got != "value" {
		t.Fatalf("readDefault = %q", got)
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		t.Fatal(err)
	}
	if err := setNoneValue(key, assocProgID); err != nil {
		key.Close()
		t.Fatal(err)
	}
	size, valueType, err := key.GetValue(assocProgID, nil)
	key.Close()
	if err != nil {
		t.Fatal(err)
	}
	if valueType != registry.NONE || size != 0 {
		t.Fatalf("REG_NONE value = type %d, len %d", valueType, size)
	}
	if err := deleteKeyTree(root); err != nil {
		t.Fatal(err)
	}
}

func TestSetPathRegisteredRoundTrip(t *testing.T) {
	app := NewApp()

	// 记录初始状态，结束后还原
	statusBefore, err := app.GetIntegrationStatus()
	if err != nil {
		t.Fatal(err)
	}

	// 开启
	if err := app.SetPathRegistered(true); err != nil {
		t.Fatalf("开启 PATH 注册失败: %v", err)
	}
	statusOn, _ := app.GetIntegrationStatus()
	if !statusOn.PathRegistered {
		t.Fatal("开启后应已注册")
	}

	// 关闭
	if err := app.SetPathRegistered(false); err != nil {
		t.Fatalf("关闭 PATH 注册失败: %v", err)
	}
	statusOff, _ := app.GetIntegrationStatus()
	if statusOff.PathRegistered {
		t.Fatal("关闭后应取消注册")
	}

	// 还原初始状态
	if statusBefore.PathRegistered {
		app.SetPathRegistered(true)
	}
}
