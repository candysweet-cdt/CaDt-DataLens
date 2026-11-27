// exists.go：会话存在性探针（不进 Wails 绑定）。
//
// 编排 supervisor 的 session_gone 判定用它确认「执行会话是否还在会话表里」。
// 只读目录与 meta，不创建任何目录——会话被删后绝不能被探测动作复活。
package sessionstore

import (
	"os"
	"path/filepath"
	"strings"
)

// SessionExists 判断会话目录（含合法 meta 或正文）是否仍存在。
// 桶化布局按 id 扫桶；平铺布局直接查根目录。
func SessionExists(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" || !ValidSessionID(id) {
		return false
	}
	store, err := Default()
	if err != nil {
		return false
	}
	var dir string
	if store.bucketed {
		resolved, err := store.resolveBucketedDir(id)
		if err != nil {
			return false
		}
		dir = resolved
	} else {
		candidate := filepath.Join(store.Root, id)
		info, statErr := os.Stat(candidate)
		if statErr != nil || !info.IsDir() {
			return false
		}
		dir = candidate
	}
	if len(store.sessionMetaRaw(dir, id)) > 0 {
		return true
	}
	info, err := os.Stat(filepath.Join(dir, aiSessionLogName))
	return err == nil && !info.IsDir()
}
