package main

// window_drop_test.go：外部拖放载荷收敛的表驱动测试（window_drop.go）。
//
// 关注两件事：① 没有落点信息时不能凭空造 target（前端会因此误判成「编辑区打开」）；
// ② 只透传 data-drop-* 属性——落点元素常常是 body 或整块面板，别的属性没有理由进 WebView。

import (
	"reflect"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestFileDropEventPayload(t *testing.T) {
	cases := []struct {
		name    string
		files   []string
		details *application.DropTargetDetails
		want    map[string]any
	}{
		{
			name:  "无落点信息只给文件名",
			files: []string{`D:\work\a.json`},
			want:  map[string]any{"filenames": []string{`D:\work\a.json`}},
		},
		{
			name:  "落点在文件树目录行",
			files: []string{`D:\src\a.png`, `D:\src\b.png`},
			details: &application.DropTargetDetails{
				X: 120, Y: 240,
				ElementID: "",
				ClassList: []string{"sb-row", "sb-dir"},
				Attributes: map[string]string{
					"data-file-drop-target": "files",
					"data-drop-dir":         `D:\work\docs`,
					"class":                 "sb-row sb-dir",
					"data-path":             `D:\work\docs`,
				},
			},
			want: map[string]any{
				"filenames": []string{`D:\src\a.png`, `D:\src\b.png`},
				"x":         120,
				"y":         240,
				"target":    "files",
				"attrs":     map[string]string{"data-drop-dir": `D:\work\docs`},
			},
		},
		{
			name:  "落点在编辑区（无 data-drop-* 附件属性）",
			files: []string{`D:\work\a.md`},
			details: &application.DropTargetDetails{
				X: 10, Y: 20,
				Attributes: map[string]string{"data-file-drop-target": "editor", "id": "editor-area"},
			},
			want: map[string]any{
				"filenames": []string{`D:\work\a.md`},
				"x":         10,
				"y":         20,
				"target":    "editor",
				"attrs":     map[string]string{},
			},
		},
		{
			name:    "落点元素没有约定属性时 target 为空串（前端按无落点处理）",
			files:   []string{`D:\work\a.md`},
			details: &application.DropTargetDetails{X: 0, Y: 0, Attributes: map[string]string{"class": "x"}},
			want: map[string]any{
				"filenames": []string{`D:\work\a.md`},
				"x":         0,
				"y":         0,
				"target":    "",
				"attrs":     map[string]string{},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := fileDropEventPayload(tc.files, tc.details)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("payload 不符：\n got=%#v\nwant=%#v", got, tc.want)
			}
		})
	}
}

func TestFileDropEventPayloadCopiesFilenames(t *testing.T) {
	files := []string{`D:\a.txt`}
	got := fileDropEventPayload(files, nil)
	files[0] = `D:\b.txt`
	out, _ := got["filenames"].([]string)
	if out[0] != `D:\a.txt` {
		t.Fatalf("载荷应复制切片，不受调用方后续修改影响：%v", out)
	}
}
