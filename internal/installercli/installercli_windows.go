//go:build windows

// installercli：安装包调用的 --integrate/--unintegrate 集成命令（文件关联、右键菜单、PATH、agent 技能）。
package installercli

import (
	"fmt"
	"os"
	"strings"

	"datalens/internal/integration"
	"datalens/internal/skills"
)

// splitIntegrationActions 解析集成项列表；all 展开为全部集成项。
func splitIntegrationActions(value string) []string {
	actions := []string{}
	for _, part := range strings.Split(value, ",") {
		action := strings.ToLower(strings.TrimSpace(part))
		if action == "" {
			continue
		}
		if action == "all" {
			actions = append(actions, "assoc", "menu", "path", "skill")
			continue
		}
		actions = append(actions, action)
	}
	return actions
}

// parseIntegrationArgs 解析安装包传入的 --integrate=... / --unintegrate=... 参数。
func parseIntegrationArgs(args []string) (string, []string) {
	mode := ""
	actions := []string{}
	for _, arg := range args {
		key, value, ok := strings.Cut(arg, "=")
		if !ok {
			continue
		}
		switch key {
		case "--integrate":
			mode = "install"
		case "--unintegrate":
			mode = "remove"
		default:
			continue
		}
		actions = append(actions, splitIntegrationActions(value)...)
	}
	// 空动作（--integrate=、--integrate=,,）此前直接跑完并打印 ok：
	// 安装器以为集成成功，实际什么都没做。留给 Run 判定并报错退出。
	return mode, actions
}

// Run 处理安装包调用的集成命令；返回 true 表示已处理并应直接退出。
func Run(args []string) bool {
	mode, actions := parseIntegrationArgs(args)
	if mode == "" {
		return false
	}
	if len(actions) == 0 {
		fmt.Fprintf(os.Stderr, "integration %s failed: 没有可执行的集成项（--integrate= 为空或全是分隔符）\n", mode)
		return true
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("integration failed: %v\n", err)
		os.Exit(2)
	}
	enabled := mode == "install"
	for _, action := range actions {
		switch action {
		case "assoc":
			if enabled {
				err = integration.RegisterFileAssociation(exe)
			} else {
				err = integration.UnregisterFileAssociation(exe)
			}
		case "menu":
			if enabled {
				err = integration.RegisterContextMenu(exe)
			} else {
				err = integration.UnregisterContextMenu()
			}
		case "path":
			err = integration.SetPathRegisteredFor(exe, enabled)
		case "skill":
			if enabled {
				err = skills.RegisterAgentSkill()
			} else {
				err = skills.UnregisterAgentSkill()
			}
		default:
			err = fmt.Errorf("未知集成项 %q", action)
		}
		if err != nil {
			fmt.Printf("%s %s failed: %v\n", mode, action, err)
			os.Exit(2)
		}
	}
	integration.NotifyShell()
	fmt.Printf("integration %s ok: %s\n", mode, strings.Join(actions, ","))
	return true
}
