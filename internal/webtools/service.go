package webtools

// service.go：Wails 绑定承载类型（App 匿名嵌入后方法自动进 *App 方法集）。
//
// 方法名与迁移前根壳（原 webtools_app.go + webtools_config.go）逐字一致，前端零改动。
// 全部是「读默认配置 → 校验来源 → 转发引擎」的薄编排；来源路由本身在前端。

// Service 是联网工具与外部工具配置的绑定承载类型。
type Service struct{}

// WebSearch 内置 Bing RSS 搜索。
func (s *Service) WebSearch(query string, maxResults int) (map[string]interface{}, error) {
	return Search(query, maxResults)
}

// WebFetch 公网网页抓取（SSRF 与重定向校验在引擎内）。
func (s *Service) WebFetch(rawURL string, maxChars int) (map[string]interface{}, error) {
	return Fetch(rawURL, maxChars)
}

// WebFetchImage 抓取公网图片并转成 data URL（AI 的 read_image 看网图走这条通道）。
func (s *Service) WebFetchImage(rawURL string) (map[string]interface{}, error) {
	return FetchImage(rawURL)
}

// ExternalSearch 走服务提供商的搜索。
func (s *Service) ExternalSearch(query string, maxResults int) (map[string]interface{}, error) {
	cfg, err := LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := RequireProvider(cfg, "search"); err != nil {
		return nil, err
	}
	return ProviderSearch(cfg, query, maxResults)
}

// ExternalFetch 走服务提供商的抓取。
func (s *Service) ExternalFetch(rawURL string, maxChars int) (map[string]interface{}, error) {
	cfg, err := LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := RequireProvider(cfg, "fetch"); err != nil {
		return nil, err
	}
	return ProviderFetch(cfg, rawURL, maxChars)
}

// ExternalOCR 走服务提供商的 OCR（按页计费）。
func (s *Service) ExternalOCR(path, purpose string) (map[string]interface{}, error) {
	cfg, err := LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := RequireProvider(cfg, "ocr"); err != nil {
		return nil, err
	}
	return ProviderOCR(cfg, path, purpose)
}

// ExternalTTS 语音合成落盘到 <workspace>/.cadt/gen/tts/，返回绝对路径与字节数。
func (s *Service) ExternalTTS(workspace, text, voice string) (map[string]interface{}, error) {
	cfg, err := LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := RequireProvider(cfg, "tts"); err != nil {
		return nil, err
	}
	return ProviderTTS(cfg, workspace, text, voice)
}

// ExternalASR 语音识别。wavBase64 非空时用转码后的音频，否则直接读 path（wav/opus）。
func (s *Service) ExternalASR(name, path, wavBase64 string) (map[string]interface{}, error) {
	cfg, err := LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	if err := RequireProvider(cfg, "asr"); err != nil {
		return nil, err
	}
	audio, err := AudioBytesForASR(path, wavBase64)
	if err != nil {
		return nil, err
	}
	return ProviderASR(cfg, name, audio)
}

// ReadAudioDataURL 读取本地音频 data URL（前端 WebAudio 转码的输入）。
func (s *Service) ReadAudioDataURL(path string) (string, error) {
	return ReadAudioDataURL(path)
}

// WebToolsConfigGet 返回掩码后的配置：apiKey 只报 apiKeySet，不回传明文。
func (s *Service) WebToolsConfigGet() (map[string]interface{}, error) {
	cfg, err := LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	return MaskedConfig(cfg), nil
}

// WebToolsConfigSave 保存配置；apiKey 留空表示保持原值（清空走 WebToolsConfigClearKey）。
func (s *Service) WebToolsConfigSave(payload map[string]interface{}) error {
	return MergeAndSaveConfig(payload)
}

// WebToolsConfigClearKey 清空服务提供商 API Key（其余配置保留）。
func (s *Service) WebToolsConfigClearKey() error {
	return ClearDefaultAPIKey()
}
