package main

// window_route.go：第二实例文件投递的窗口路由（决策层在 internal/secondinstance，
// 这里只剩「按路径找归属窗口」这一步——它要读注册表，所以留在根）。
//
// 缺陷 E（方案 §3.4）：从文件所在目录逐级向上，每一级与已登记工作区键
// （pathKeyForCompare 归一）精确相等匹配，第一个命中的级别即「最深包含工作区」；
// 盘根无命中返回空串（投主窗口）。存在的目录目标不路由（前端 openFolderSmart
// 自有工作区逻辑）；不存在的目标按文件处理从所在目录起爬——纯字符串祖先链，
// 报错也报在归属窗口里。窗口工作区由前端 WindowRegister 实时登记（切换即更新、
// 关闭登记空串退出匹配），这里只读。

import (
	"os"
	"path/filepath"
)

func routeWindowForPath(path string) string {
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return ""
	}
	dir := pathKeyForCompare(filepath.Dir(path))
	for dir != "" {
		if st := winReg.FindByWorkspace(dir, ""); st != nil {
			return st.Name()
		}
		parent := pathKeyForCompare(filepath.Dir(dir))
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}
