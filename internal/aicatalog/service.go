package aicatalog

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
// 方法名与迁移前根壳（原 ai_catalog_app.go）逐字一致，前端零改动。

import (
	"context"
	"time"
)

// Service 是模型配置表的绑定承载类型。
type Service struct{}

// AIModelCatalogCached 读缓存；没有缓存返回空 blob（不是错误——内置表兜底）。
func (s *Service) AIModelCatalogCached() (*Blob, error) {
	return Cached()
}

// AIModelCatalogSync 拉取远端表：校验通过才落盘，失败时旧缓存原样保留。
func (s *Service) AIModelCatalogSync(rawURL string) (*Blob, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return Sync(ctx, rawURL)
}
