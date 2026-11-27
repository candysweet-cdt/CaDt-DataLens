package vercmp

import "testing"

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.3.0", "1.3.0", 0},
		{"v1.3.0", "1.3.0", 0},
		{"1.4.0", "1.3.9", 1},
		{"1.3", "1.3.0", 0},
		// 预发布后缀：旧实现把非数字段当 0，v1.3.1-beta 会与 v1.3.0 比不出来
		{"1.3.1-beta", "1.3.0", 1},
		{"1.3.0-rc1", "1.3.0", 0},
		{"1.3.2beta", "1.3.1", 1},
		{"", "1.0.0", -1},
	}
	for _, tc := range cases {
		if got := Compare(tc.a, tc.b); got != tc.want {
			t.Fatalf("Compare(%q, %q) = %d，期望 %d", tc.a, tc.b, got, tc.want)
		}
	}
}
