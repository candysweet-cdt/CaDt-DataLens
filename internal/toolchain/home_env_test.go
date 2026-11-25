//go:build windows

package toolchain

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestHomeEnvGlob(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		parts   []string
		want    string
		setEnv  bool
	}{
		{
			name: "环境变量未设置 → 空串",
			setEnv: false,
			parts: []string{"bin", "node.exe"},
			want: "",
		},
		{
			name: "正常绝对路径 → 拼出 glob",
			setEnv: true,
			value: `C:\Users\alice\AppData\Roaming\nvm`,
			parts: []string{"v*", "node.exe"},
			want: filepath.Join(`C:\Users\alice\AppData\Roaming\nvm`, "v*", "node.exe"),
		},
		{
			name: "相对路径 → 拒绝，避免拼出畸形路径",
			setEnv: true,
			value: `nvm`,
			parts: []string{"v*", "node.exe"},
			want: "",
		},
		{
			name: "带引号与尾部空格 → 清洗后拼出",
			setEnv: true,
			value: `"D:\Tools\Maven" `,
			parts: []string{"bin", "mvn.cmd"},
			want: filepath.Join(`D:\Tools\Maven`, "bin", "mvn.cmd"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setEnv {
				t.Setenv("CADT_TEST_HOME", tt.value)
			} else {
				t.Setenv("CADT_TEST_HOME", "")
			}
			got := homeEnvGlob("CADT_TEST_HOME", tt.parts...)
			if got != tt.want {
				t.Errorf("homeEnvGlob() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAppendEnvGlobsSkipsEmpty(t *testing.T) {
	got := appendEnvGlobs([]string{"base"}, "", "a", "", "b")
	want := []string{"base", "a", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("appendEnvGlobs() = %#v, want %#v", got, want)
	}
}
