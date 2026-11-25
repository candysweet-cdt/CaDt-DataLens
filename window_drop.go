package main

// window_drop.go：外部文件拖放事件载荷的收敛（window_factory.go 的 emit 点只调这里）。
//
// Wails v3 在 Windows 上把 OS 拖放转成两跳：JS drop → chrome.webview.postMessage(坐标) →
// Go → JS handlePlatformFileDrop(找 [data-file-drop-target] 祖先) → Go 的 WindowFilesDropped。
// 事件自带的 DropTargetDetails 是「落点在哪」的唯一可靠来源（坐标 + 元素属性），
// 丢了这个信息前端就只能靠「刚才谁被 dragover 过」猜，历史的 5 秒 pending hack 就是猜法的产物。
//
// 纪律：只透传 data-drop-* 前缀的属性——落点元素可能是 body 或整块面板，别的属性
// （style / class / 业务 data-*）没有理由进 WebView，也没必要让前端看到一个元素的全部底细。

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// dropAttrPrefix 允许透传给前端的落点属性前缀（data-drop-dir 等）。
const dropAttrPrefix = "data-drop-"

// dropTargetAttr 是 Wails 约定的落点属性名（runtime 用 closest('[data-file-drop-target]') 匹配）。
const dropTargetAttr = "data-file-drop-target"

// fileDropEventPayload 把一次外部拖放收敛成前端可路由的载荷：
//
//	{filenames:[...], x, y, target:'files'|'editor'|'db'|'ai'|'', attrs:{"data-drop-dir":"..."}}
//
// details 为 nil（非 Windows / 无落点元素）时只给 filenames，前端按「无落点」处理。
func fileDropEventPayload(files []string, details *application.DropTargetDetails) map[string]any {
	payload := map[string]any{"filenames": append([]string(nil), files...)}
	if details == nil {
		return payload
	}
	attrs := make(map[string]string, len(details.Attributes))
	for key, value := range details.Attributes {
		if strings.HasPrefix(key, dropAttrPrefix) {
			attrs[key] = value
		}
	}
	payload["x"] = details.X
	payload["y"] = details.Y
	payload["target"] = details.Attributes[dropTargetAttr]
	payload["attrs"] = attrs
	return payload
}
