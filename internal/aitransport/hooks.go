package aitransport

import (
	"os"
	"time"
)

// 宿主注入（main 包的根壳在 init 中接线）。
var (
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
	// Version 应用版本，用于 User-Agent（main/app_core.go 的 appVersion）。
	Version = ""
	// LogsDir 应用日志目录，4xx 请求体转储落在这里（internal/applog.Dir）。
	LogsDir func() string
	// AttachWatchdog 把空闲看门狗挂到会话的流条目上，供 AITouchStream 重置
	// （internal/aichat/stream.go 的流注册表）。
	// idle 是本次请求实际生效的空闲超时（用户可配 30–3600s）：AITouchStream 必须
	// 按它重置，用全局默认 300s 会把用户配置双向覆盖掉。
	AttachWatchdog func(id string, watchdog *time.Timer, idle time.Duration)
)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

// logsDir 日志目录的 nil 安全包装；未注入时退到系统临时目录（测试环境）。
func logsDir() string {
	if LogsDir != nil {
		return LogsDir()
	}
	return os.TempDir()
}
