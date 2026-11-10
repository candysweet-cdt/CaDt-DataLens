//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
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
	return mode, actions
}

// runInstallerCommand 处理安装包调用的集成命令；返回 true 表示已处理并应直接退出。
func runInstallerCommand(args []string) bool {
	mode, actions := parseIntegrationArgs(args)
	if mode == "" {
		return false
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
				err = registerFileAssociation(exe)
			} else {
				err = unregisterFileAssociation(exe)
			}
		case "menu":
			if enabled {
				err = registerContextMenu(exe)
			} else {
				err = unregisterContextMenu()
			}
		case "path":
			err = setPathRegisteredFor(exe, enabled)
		case "skill":
			if enabled {
				err = RegisterAgentSkill()
			} else {
				err = UnregisterAgentSkill()
			}
		default:
			err = fmt.Errorf("未知集成项 %q", action)
		}
		if err != nil {
			fmt.Printf("%s %s failed: %v\n", mode, action, err)
			os.Exit(2)
		}
	}
	notifyShell()
	fmt.Printf("integration %s ok: %s\n", mode, strings.Join(actions, ","))
	return true
}
