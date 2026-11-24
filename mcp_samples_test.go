package main

// mcp_samples_test.go：内置 MCP 示例的自愈钩子接线护栏。
// 逻辑本体在 internal/mcpsamples（有单测），这里只守「根壳有没有接上」——
// 漏接时应用照常编译，但脚本被存储清理删掉后服务器会永久起不来。

import (
	"os"
	"strings"
	"testing"

	"datalens/internal/mcp"
)

func TestMCPSampleHealHookWired(t *testing.T) {
	if mcp.PrepareServer == nil {
		t.Fatal("mcp.PrepareServer 未接线：内置示例脚本被存储清理删掉后无法自愈")
	}
}

// 安装示例绕过 Client 直接写 mcp.json，必须补一次 ApplyConfigFromDisk 把新 server 挂进
// 运行态管理器，否则 MCPSnapshot 看不到它、不发 mcp-tools-changed——表现就是装好了列表
// 不刷新，退出重进才出现。这里是源码接线守卫（真跑安装会拉进程，放 internal 包做集成测试）。
func TestMCPInstallSampleAppliesConfig(t *testing.T) {
	src, err := os.ReadFile("embed_assets.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "mcp.ApplyConfigFromDisk(a.Client)") {
		t.Fatal("MCPInstallSample 写盘后必须调用 mcp.ApplyConfigFromDisk 应用到运行态")
	}
}
