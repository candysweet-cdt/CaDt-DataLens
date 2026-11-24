package windowgeom

// keys.go：窗口几何的存储 key（原在根 window_geometry.go 的 geometryRestoreKey /
// geometryPersistKey，纯函数、与 Wails 无关，随包下沉以便单测）。
//
// 角色而不是窗口名做 key：窗口名随打开顺序变化（main-2 这次是第二个窗口，下次
// 可能是另一个工作区），按名字存会让位置在重启后错位。
//
// mode 用字符串而不是宿主类型：windowreg → windowgeom 是单向依赖（Spec 里带
// Rect），这里若反过来引用 Mode 会成环。

// RestoreKey 给出窗口创建时的存储 key 与级联层数。
// modeCount 是含本窗口在内的同形态窗口数（调用时窗口已登记到注册表）。
// key 为空表示该窗口不参与几何记忆（如非首个浮窗）。
func RestoreKey(mode, name string, modeCount int) (key string, cascade int) {
	switch mode {
	case "float":
		if name == "float" {
			return "float", 0
		}
		return "", 0
	case "debug":
		if name == "debug" {
			return "debug", 0
		}
		return "", 0
	case "terminal":
		// 终端窗口数量不定：都从 "terminal" 槽位级联，避免叠在一起。
		return "terminal", extra(modeCount)
	case "memo", "monitor", "diff", "light", "preview":
		// 辅助窗（便签/监控/对比/轻量查看/实时预览）：数量不定，同形态槽位级联。
		return mode, extra(modeCount)
	default:
		return "main", extra(modeCount)
	}
}

// PersistKey 给出窗口移动/关闭时的存储 key；空串表示不持久化。
// 额外主窗口（非当前 primary）只参与显示，不覆盖 main 的位置。
func PersistKey(mode, name string, isPrimary bool) string {
	switch mode {
	case "float":
		if name == "float" {
			return "float"
		}
	case "debug":
		if name == "debug" {
			return "debug"
		}
	case "terminal":
		// 终端窗口数量不定，全部写同一个槽位（最后一次移动的窗口生效）。
		return "terminal"
	case "memo", "monitor", "diff", "light", "preview":
		return mode
	default:
		if isPrimary {
			return "main"
		}
	}
	return ""
}

// extra 把「同形态窗口数」换算成级联层数（首个窗口不偏移）。
func extra(count int) int {
	if count-1 < 0 {
		return 0
	}
	return count - 1
}
