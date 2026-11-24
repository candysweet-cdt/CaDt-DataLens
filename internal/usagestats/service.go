package usagestats

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 usage_stats_app.go）逐字一致，前端零改动。
//
// 事实库是派生 SQLite（ai-usage.db，可随时删除重建）；前端流结束静默上报，
// 后台带游标增量回填会话 JSONL，查询只读库——打开面板不扫文件。

// Service 是 AI 使用统计的绑定承载类型。
type Service struct{}

// AIUsageStatsRecord 静默上报一条用量事实（幂等；失败返回错误文本，前端忽略）。
func (s *Service) AIUsageStatsRecord(payloadJSON string) string {
	if err := Record(payloadJSON); err != nil {
		// 前端静默消费返回值：写失败的诊断信息必须落在运行日志里，否则永久静默
		if Logf != nil {
			Logf("warn", "AI 使用统计上报失败：%v", err)
		}
		return err.Error()
	}
	return ""
}

// AIUsageStatsSnapshot 读取统计快照（rangeKey: 7d/30d；summary 与热力图始终全历史）。
func (s *Service) AIUsageStatsSnapshot(rangeKey string) Snapshot {
	snap, err := LoadSnapshot(rangeKey)
	if err != nil {
		snap.Range = rangeKey
		snap.Error = err.Error()
	}
	return snap
}

// AIUsageStatsRequests 按时间倒序分页读取请求日志（只读库，不触发扫描）。
func (s *Service) AIUsageStatsRequests(offset, limit int) RequestPage {
	page, err := LoadRequests(offset, limit)
	if err != nil {
		page.Error = err.Error()
	}
	return page
}

// AIUsageStatsSync 手动触发增量同步（刷新按钮），返回错误文本（空 = 成功）。
func (s *Service) AIUsageStatsSync() string {
	if err := SyncAll(); err != nil {
		return err.Error()
	}
	return ""
}
