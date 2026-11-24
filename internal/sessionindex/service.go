package sessionindex

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 sessionindex_app.go）逐字一致，前端零改动。
//
// 这五个绑定都只是「取默认会话存储 + 转发」；存储实例的构造依赖
// internal/sessionstore 的宿主注入（AppDataDir），本包不感知窗口与 App。

import "datalens/internal/sessionstore"

// Service 是会话搜索索引的绑定承载类型。
type Service struct{}

// AISessionSearch 跨会话检索（简要模式：只含用户消息与每轮最后一条助手回复）。
func (s *Service) AISessionSearch(query string, limit int) ([]SearchHit, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return nil, err
	}
	return Search(store, query, limit)
}

// AISessionSearchScoped 跨会话检索（brief=true 时走简要模式）。
func (s *Service) AISessionSearchScoped(query string, limit int, brief bool) (ScopedSearchResult, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return ScopedSearchResult{}, err
	}
	return SearchScoped(store, query, limit, brief)
}

// AISessionReindex 重建索引（JSONL 仍是唯一真源）。
func (s *Service) AISessionReindex() (int, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return 0, err
	}
	return Reindex(store)
}

// AISessionIndexStats 索引统计（前端设置页展示）。
func (s *Service) AISessionIndexStats() (IndexStats, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return IndexStats{}, err
	}
	return Stats(store)
}

// AISessionIndexPath 返回索引库文件路径。
func (s *Service) AISessionIndexPath() (string, error) {
	return Path(), nil
}
