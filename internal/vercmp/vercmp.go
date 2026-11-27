package vercmp

import (
	"strconv"
	"strings"
)

// Compare 比较数字版本号（可带 v 前缀、按点分隔的 1–3 段），返回 -1/0/1。
func Compare(a, b string) int {
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.TrimSpace(v), "v")
		parts := strings.Split(v, ".")
		out := make([]int, 0, 3)
		for _, part := range parts {
			// 非数字段（-beta / rc1）按 0 处理会让 v1.3.0-beta 与 v1.3.0 等值，
			// 有预发布版更新时永远提示不了。取开头的数字前缀（"3beta" → 3）。
			digits := 0
			for digits < len(part) && part[digits] >= '0' && part[digits] <= '9' {
				digits++
			}
			n := 0
			if digits > 0 {
				n, _ = strconv.Atoi(part[:digits])
			}
			out = append(out, n)
		}
		return out
	}
	ap, bp := parse(a), parse(b)
	for i := 0; i < 3; i++ {
		av, bv := 0, 0
		if i < len(ap) {
			av = ap[i]
		}
		if i < len(bp) {
			bv = bp[i]
		}
		if av != bv {
			if av > bv {
				return 1
			}
			return -1
		}
	}
	return 0
}
