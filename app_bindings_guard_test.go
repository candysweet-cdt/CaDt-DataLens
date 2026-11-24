package main

// app_bindings_guard_test.go：Wails 绑定方法名的基线守卫。
//
// v3 没有绑定代码生成，前端经 Call.ByName('main.App.<Method>') 运行时解析——
// 绑定面就是 *App 的方法集，**包含嵌入服务的提升方法**（wails v3 的
// pkg/application/bindings.go:236 用 ptrType.NumMethod() 遍历，FQN 取类型名，
// 所以下沉到 internal 包的服务方法仍是 main.App.X）。
//
// 两个方向都要拦：
//   - 少一个方法：前端调用时才会报「方法不存在」，测试期发现不了；
//   - 多一个方法：internal 包的内部助手被意外导出成绑定。
//     历史事故：Scheduler.Start（B8）、Manager.EnsureDir（C1a）。
//
// 更新基线（改完必须人工核对差集，并在提交信息里说明）：
//
//	UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .
//
// 基线文件 testdata/app_bindings_baseline.txt 一行一个方法名，已排序。

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// wailsInternalMethods 与 wails v3 pkg/application/bindings.go:195 的
// internalServiceMethods 同口径：这些名字不会被暴露成绑定（过滤掉才与真实
// 绑定面一致）。
var wailsInternalMethods = map[string]bool{
	"ServiceName":     true,
	"ServiceStartup":  true,
	"ServiceShutdown": true,
	"ServeHTTP":       true,
}

const bindingsBaselinePath = "testdata/app_bindings_baseline.txt"

// appBindingNames 返回当前 *App 方法集里会被 Wails 绑定的方法名（已排序）。
// 用 reflect.TypeOf(&App{}) 而不是 NewApp()：方法集由类型决定，零值足够，
// 不触发各服务构造。
func appBindingNames() []string {
	typ := reflect.TypeOf(&App{})
	names := make([]string, 0, typ.NumMethod())
	for i := range typ.NumMethod() {
		name := typ.Method(i).Name
		if wailsInternalMethods[name] {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// readBindingsBaseline 读基线文件（空行与 # 注释忽略）。
func readBindingsBaseline(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(bindingsBaselinePath))
	if err != nil {
		t.Fatalf("读绑定基线失败：%v（首次生成：UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .）", err)
	}
	lines := make([]string, 0, 300)
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

// TestAppBindingBaseline 是绑定面的唯一守卫：多一个、少一个都红。
func TestAppBindingBaseline(t *testing.T) {
	current := appBindingNames()
	if current == nil || len(current) == 0 {
		t.Fatal("方法集为空：*App 的绑定方法一个都没取到，反射口径已变")
	}

	if os.Getenv("UPDATE_BINDINGS_BASELINE") == "1" {
		body := "# *App 的 Wails 绑定方法名基线（排序，一行一个）。\n" +
			"# 由 app_bindings_guard_test.go 生成与校验，不要手改：\n" +
			"#   UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline .\n" +
			strings.Join(current, "\n") + "\n"
		if err := os.MkdirAll(filepath.Dir(bindingsBaselinePath), 0o755); err != nil {
			t.Fatalf("建 testdata 目录失败：%v", err)
		}
		if err := os.WriteFile(bindingsBaselinePath, []byte(body), 0o644); err != nil {
			t.Fatalf("写基线失败：%v", err)
		}
		t.Logf("已写入 %d 个绑定方法到 %s", len(current), bindingsBaselinePath)
		return
	}

	baseline := readBindingsBaseline(t)
	if len(baseline) == 0 {
		t.Fatal("绑定基线为空：基线文件被清空了")
	}

	// 负向断言：这几个名字历史上都是「内部助手被提升成绑定」的代表。
	// 更新基线时无脑全量写入会把这些事故一起写进基线，所以连基线本身也查。
	for _, banned := range []string{"Start", "Close", "EnsureDir", "ServiceStartup"} {
		for _, name := range baseline {
			if name == banned {
				t.Errorf("基线里出现疑似内部助手 %q——它不该是前端可调的绑定", banned)
			}
		}
	}

	set := make(map[string]bool, len(current))
	for _, name := range current {
		set[name] = true
	}
	want := make(map[string]bool, len(baseline))
	for _, name := range baseline {
		want[name] = true
	}

	var missing, added []string
	for _, name := range baseline {
		if !set[name] {
			missing = append(missing, name)
		}
	}
	for _, name := range current {
		if !want[name] {
			added = append(added, name)
		}
	}

	if len(missing) == 0 && len(added) == 0 {
		return
	}

	if len(missing) > 0 {
		t.Errorf("绑定丢失 %d 个（前端会报「方法不存在」）：\n  %s", len(missing), strings.Join(missing, "\n  "))
	}
	if len(added) > 0 {
		t.Errorf("多出 %d 个绑定（内部助手被意外提升，或需更新基线）：\n  %s", len(added), strings.Join(added, "\n  "))
	}
	t.Logf("确属预期变更时用 UPDATE_BINDINGS_BASELINE=1 go test -run TestAppBindingBaseline . 更新基线，并在提交信息里写明差集")
}
