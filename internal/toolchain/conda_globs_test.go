//go:build windows

package toolchain

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestCondaPythonGlobs(t *testing.T) {
	tests := []struct {
		name       string
		home       string
		local      string
		programData string
		want       []string
	}{
		{
			name:        "全部环境变量齐全：用户目录 / LOCALAPPDATA / ProgramData / C 盘根",
			home:        `C:\Users\alice`,
			local:       `C:\Users\alice\AppData\Local`,
			programData: `C:\ProgramData`,
			want: []string{
				filepath.Join(`C:\Users\alice`, "[Aa]naconda3", "python.exe"),
				filepath.Join(`C:\Users\alice`, "[Mm]iniconda3", "python.exe"),
				filepath.Join(`C:\Users\alice\AppData\Local`, "Continuum", "[Aa]naconda3", "python.exe"),
				filepath.Join(`C:\Users\alice\AppData\Local`, "[Mm]iniconda3", "python.exe"),
				filepath.Join(`C:\ProgramData`, "[Aa]naconda3", "python.exe"),
				filepath.Join(`C:\ProgramData`, "[Mm]iniconda3", "python.exe"),
				filepath.Join(`C:\`, "[Aa]naconda3", "python.exe"),
				filepath.Join(`C:\`, "[Mm]iniconda3", "python.exe"),
			},
		},
		{
			name:        "环境变量为空时跳过对应来源，C 盘根路径仍在",
			home:        "",
			local:       "",
			programData: "",
			want: []string{
				filepath.Join(`C:\`, "[Aa]naconda3", "python.exe"),
				filepath.Join(`C:\`, "[Mm]iniconda3", "python.exe"),
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := condaPythonGlobs(tt.home, tt.local, tt.programData)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("condaPythonGlobs() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

// 大小写通配必须同时命中 Anaconda3 与 anaconda3（大小写不敏感）。
func TestCondaPythonGlobMatchesBothCases(t *testing.T) {
	pattern := filepath.Join(`C:\`, "[Aa]naconda3", "python.exe")
	for _, p := range []string{
		filepath.Join(`C:\`, "Anaconda3", "python.exe"),
		filepath.Join(`C:\`, "anaconda3", "python.exe"),
	} {
		matched, err := filepath.Match(pattern, p)
		if err != nil {
			t.Fatalf("filepath.Match(%q, %q) error: %v", pattern, p, err)
		}
		if !matched {
			t.Errorf("pattern %q 未命中 %q", pattern, p)
		}
	}
}
