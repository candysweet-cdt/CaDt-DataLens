// mcp_manager.go：多 server 编排——惰性启动、世代交换发布、状态聚合、重连调度、
// tools/call 路由、配置应用与全量关闭。核心逻辑不依赖 App；Wails 薄包装在 mcp_app.go。
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"
)

// 宿主注入：诊断日志与 appdata 目录由 main 包 init 注入（mcp_app.go）；
// 未注入（测试 / 独立使用）时日志静默、配置路径为空。
var (
	Logf       func(level, format string, args ...any)
	AppDataDir func() string
	Version    string
	// PrepareServer 在每代连接真正 spawn 前调用（main 包注入 mcpsamples 的自愈实现）：
	// 内置示例脚本被「设置 → 存储清理」当缓存删掉、或版本升级换了释放目录时，
	// 已注册的服务器会永久初始化失败（还带十次重连与刷屏日志），这里按配置里的原路径补回。
	// 只读 cfg，不改配置；实现失败必须静默放过，让服务器自己报真实错误。
	PrepareServer func(cfg MCPServerConfig)
)

// ===== 重连策略与条目状态 =====
// logf 宿主日志钩子的 nil 安全包装。
func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

const (
	mcpReconnectInitialDelayMs = 500
	mcpReconnectMaxDelayMs     = 30000
	mcpReconnectMaxAttempts    = 10
	mcpCloseAllBudget          = 8 * time.Second // 应用退出时全量关闭的总预算
)

// mcpReconnectPolicy 指数退避：500ms → 30s、10 次预算、稳定运行后重置。
// 字段可注入（测试用微小时延），delayFor 是纯函数。
type mcpReconnectPolicy struct {
	Enabled        bool
	InitialDelayMs int
	MaxDelayMs     int
	MaxAttempts    int
}

func defaultMCPReconnectPolicy() mcpReconnectPolicy {
	return mcpReconnectPolicy{Enabled: true, InitialDelayMs: mcpReconnectInitialDelayMs, MaxDelayMs: mcpReconnectMaxDelayMs, MaxAttempts: mcpReconnectMaxAttempts}
}

func (p mcpReconnectPolicy) delayFor(attempt int) time.Duration {
	base, max := p.InitialDelayMs, p.MaxDelayMs
	if base <= 0 {
		base = mcpReconnectInitialDelayMs
	}
	if max <= 0 {
		max = mcpReconnectMaxDelayMs
	}
	d := base << (attempt - 1)
	if d > max || d <= 0 {
		d = max
	}
	return time.Duration(d) * time.Millisecond
}

// mcpServerEntry 单个 server 的运行态。registry 是该 server 的完整工具世代，原子替换。
type mcpServerEntry struct {
	name string
	cfg  MCPServerConfig

	status     mcpStatus // 六态（closed/connecting/connected/reconnecting/failed + 预留）
	client     *mcpClient
	connecting bool // connectGeneration 进行中（惰性启动去重）
	blocking   bool // unclosed-generation：禁止替换与探测
	disposed   bool // 配置已移除该 server，收尾后从表里删掉

	registry   []mcpPublicToolDef // 当前世代工具集（nil = 未注册）
	staleTools []string           // 勾选了但 server 已不存在的工具名（对账提示用）

	failedAttempts int
	connectedAt    time.Time
	retryTimer     *time.Timer
	quit           chan struct{}
	quitOnce       sync.Once
	resyncCh       chan struct{} // tools/list_changed 合并信号（容量 1：连推 N 次合并为一次）
}

func (entry *mcpServerEntry) setStatusLocked(mutate func(*mcpStatus)) {
	mutate(&entry.status)
}

type mcpRoute struct {
	Server    string
	Raw       string
	OpenWorld bool
}

// ===== 管理器与配置应用 =====
// mcpManager 多 server 编排。mu 保护 servers 表 / registry / routes；connect 等慢操作不持锁，
// 完成后回到锁内做 eligible 检查（entry 未被丢弃且客户端代仍是自己）再发布。
type Manager struct {
	mu      sync.Mutex
	enabled bool
	servers map[string]*mcpServerEntry
	routes  map[string]mcpRoute // publicName → 路由；每次世代交换后重建
	config  MCPConfig

	policy mcpReconnectPolicy
	emit   func(event string, payload any)
	now    func() time.Time
}

func NewManager(emit func(event string, payload any)) *Manager {
	return &Manager{
		enabled: true,
		servers: map[string]*mcpServerEntry{},
		routes:  map[string]mcpRoute{},
		policy:  defaultMCPReconnectPolicy(),
		emit:    emit,
		now:     time.Now,
	}
}

// setEnabled 总开关：关闭时工具全部注销、进程全部停止；重新打开后下次取快照惰性重启。
// 不做「值相同就跳过」的守卫——applyConfig 关闭路径依赖这里必定执行停止。
func (m *Manager) setEnabled(on bool) {
	m.mu.Lock()
	m.enabled = on
	entries := make([]*mcpServerEntry, 0, len(m.servers))
	for _, entry := range m.servers {
		entries = append(entries, entry)
	}
	m.mu.Unlock()
	if on {
		return // 重新启用：不主动起进程，等 lazyStartAll 惰性启动
	}
	for _, entry := range entries {
		m.stopEntry(entry)
	}
	m.emitTools()
}

// applyConfig 应用新配置：删除消失/停用的 server，重建配置变化的 server，
// EnabledTools-only 变化直接用现有连接重建世代（不重启进程）。
func (m *Manager) ApplyConfig(cfg MCPConfig) {
	m.mu.Lock()
	m.config = cfg
	m.enabled = mcpConfigEnabled(cfg)
	if !m.enabled {
		m.mu.Unlock()
		m.setEnabled(false) // 总开关关闭：工具全部移除、进程全部停止
		return
	}
	var stops []*mcpServerEntry
	var starts []string
	for name, entry := range m.servers {
		newCfg, ok := cfg.MCPServers[name]
		if !ok || !mcpServerEnabled(newCfg) {
			entry.disposed = true
			stops = append(stops, entry)
			continue
		}
		if !reflect.DeepEqual(stripRuntimeFields(entry.cfg), stripRuntimeFields(newCfg)) {
			entry.disposed = true
			stops = append(stops, entry)
			starts = append(starts, name)
			continue
		}
		toolsChanged := !reflect.DeepEqual(entry.cfg.EnabledTools, newCfg.EnabledTools)
		entry.cfg = newCfg
		if toolsChanged && entry.client != nil {
			m.rebuildGenerationLocked(entry, entry.client.currentTools())
		}
	}
	for name, newCfg := range cfg.MCPServers {
		if _, exists := m.servers[name]; exists {
			continue
		}
		if !mcpServerEnabled(newCfg) {
			continue // 停用的条目不建运行态
		}
		if err := ValidateServer(name, newCfg); err != nil {
			// 读盘是宽松的（写盘才强校验）：手改出的坏条目不建运行态，记日志供诊断
			logf("warn", "MCP 配置条目 %q 不合法，跳过：%v", name, err)
			continue
		}
		m.newEntryLocked(name, newCfg)
		if len(newCfg.EnabledTools) > 0 {
			starts = append(starts, name)
		}
	}
	m.mu.Unlock()

	// 关闭在锁外（慢操作）；等关闭确认后再从表里删除（§9.3：未确认不替换）
	for _, entry := range stops {
		m.stopEntry(entry)
		m.mu.Lock()
		delete(m.servers, entry.name)
		m.mu.Unlock()
	}
	for _, name := range starts {
		if newCfg, ok := cfg.MCPServers[name]; ok && mcpServerEnabled(newCfg) {
			m.mu.Lock()
			if _, exists := m.servers[name]; !exists {
				m.newEntryLocked(name, newCfg)
			}
			m.mu.Unlock()
		}
		m.ensureStarted(name)
	}
	m.emitTools()
}

func stripRuntimeFields(s MCPServerConfig) MCPServerConfig {
	out := s
	out.Enabled = nil
	out.EnabledTools = nil
	// Notes 只进提示词，不影响进程与工具集：不剥离的话，改一段备注也会被判定成
	// 「配置变了」→ 关掉再重启 server，纯属自找中断。
	out.Notes = ""
	return out
}

func (m *Manager) newEntryLocked(name string, cfg MCPServerConfig) *mcpServerEntry {
	entry := &mcpServerEntry{
		name:     name,
		cfg:      cfg,
		quit:     make(chan struct{}),
		resyncCh: make(chan struct{}, 1),
	}
	entry.status.State = "closed" // §9.1：closed = 未启动或已正常关闭
	m.servers[name] = entry
	return entry
}

// ===== 启动与重连 =====
// ensureStarted 惰性启动：仅 enabled 且 EnabledTools 非空、未连接、未在连接、未阻塞的 server。
func (m *Manager) ensureStarted(name string) {
	m.mu.Lock()
	entry, ok := m.servers[name]
	if !ok || !m.enabled || entry.connecting || entry.blocking || entry.disposed || entry.client != nil {
		m.mu.Unlock()
		return
	}
	if !mcpServerEnabled(entry.cfg) || len(entry.cfg.EnabledTools) == 0 {
		m.mu.Unlock()
		return
	}
	entry.connecting = true
	m.mu.Unlock()
	go m.connectGeneration(name)
}

// lazyStartAll 首次需要工具清单时并发启动所有候选 server（各自独立预算）。
func (m *Manager) LazyStartAll() {
	m.mu.Lock()
	names := make([]string, 0, len(m.servers))
	for name, entry := range m.servers {
		if !m.enabled || entry.client != nil || entry.connecting || entry.blocking || entry.disposed {
			continue
		}
		if len(entry.cfg.EnabledTools) == 0 {
			continue
		}
		names = append(names, name)
	}
	m.mu.Unlock()
	for _, name := range names {
		m.ensureStarted(name)
	}
}

// connectGeneration 一代连接的全生命周期：启动 → 握手 → 列表 → 世代发布。
// connect 慢操作不持锁；发布前做 eligible 检查，防止废弃连接把工具挂上去。
func (m *Manager) connectGeneration(name string) {
	m.mu.Lock()
	entry, ok := m.servers[name]
	if !ok || entry.disposed || !m.enabled {
		if ok {
			entry.connecting = false
		}
		m.mu.Unlock()
		return
	}
	cfg := entry.cfg
	entry.connecting = true
	entry.setStatusLocked(func(s *mcpStatus) {
		s.State = "connecting"
		s.Attempt = 0
	})
	m.emitStatusLocked()
	m.mu.Unlock()

	client := newMCPClient(name, cfg)
	client.onToolsChanged = func() { m.queueResync(name) }
	client.onLost = func(reason string) { m.onLost(name, client, reason) }
	err := client.connect(context.Background())

	m.mu.Lock()
	if entry.disposed || !m.enabled {
		// 连接期间被配置变更/总开关丢弃：这代连接无权发布，直接收尾
		entry.connecting = false
		m.mu.Unlock()
		client.close()
		return
	}
	if err != nil {
		entry.connecting = false
		m.scheduleReconnectLocked(entry, mcpRedactSecrets(cfg.Env, err.Error()))
		m.emitStatusLocked()
		m.mu.Unlock()
		client.close()
		return
	}
	// eligible 检查通过：发布整代工具
	entry.client = client
	entry.connectedAt = m.now()
	m.rebuildGenerationLocked(entry, client.currentTools())
	entry.connecting = false
	m.emitStatusLocked()
	m.emitToolsLocked()
	m.mu.Unlock()

	m.startResyncLoop(entry)
}

// rebuildGenerationLocked 构建并原子替换 entry 的工具世代 + 重建全局路由表。
func (m *Manager) rebuildGenerationLocked(entry *mcpServerEntry, tools map[string]RemoteTool) {
	defs, stale, err := mcpBuildToolSet(entry.name, tools, entry.cfg.EnabledTools)
	if err != nil {
		// hash 碰撞等构建失败：整代回滚，该 server 零工具
		logf("error", "MCP %s 工具世代构建失败：%v", entry.name, err)
		entry.registry = nil
		entry.staleTools = nil
	} else {
		entry.registry = defs
		entry.staleTools = stale
		if len(stale) > 0 {
			logf("warn", "MCP %s 勾选的工具已不存在（对账提示）：%v", entry.name, stale)
		}
	}
	entry.setStatusLocked(func(s *mcpStatus) {
		s.State = "connected"
		s.Reason = ""
		s.LastError = ""
		if entry.registry == nil {
			s.ToolCount = 0
		} else {
			s.ToolCount = len(entry.registry)
		}
	})
	m.rebuildRoutesLocked()
}

func (m *Manager) rebuildRoutesLocked() {
	routes := map[string]mcpRoute{}
	for _, entry := range m.servers {
		for _, def := range entry.registry {
			routes[def.PublicName] = mcpRoute{Server: entry.name, Raw: def.RawName, OpenWorld: def.OpenWorld}
		}
	}
	m.routes = routes
}

// startResyncLoop 单 server 的串行重同步消费者：容量 1 的信号 channel 天然合并通知风暴。
func (m *Manager) startResyncLoop(entry *mcpServerEntry) {
	go func() {
		for {
			select {
			case <-entry.resyncCh:
			case <-entry.quit:
				return
			}
			m.resyncEntry(entry.name)
		}
	}()
}

func (m *Manager) queueResync(name string) {
	m.mu.Lock()
	entry, ok := m.servers[name]
	var ch chan struct{}
	if ok && entry.client != nil {
		ch = entry.resyncCh
	}
	m.mu.Unlock()
	if ch != nil {
		select {
		case ch <- struct{}{}:
		default: // 已有待处理信号：合并
		}
	}
}

// ===== 重同步与断线处理 =====
// resyncEntry 重新拉取工具清单并重建世代。失败保留上一代（连接继续用），只记日志。
func (m *Manager) resyncEntry(name string) {
	m.mu.Lock()
	entry, ok := m.servers[name]
	if !ok || entry.client == nil || entry.disposed {
		m.mu.Unlock()
		return
	}
	client := entry.client
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), client.cfg.callTimeout())
	defer cancel()
	tools, err := client.listTools(ctx)

	m.mu.Lock()
	if !ok || entry.client != client || entry.disposed {
		m.mu.Unlock()
		return // 世代已换代：这批结果无权发布（eligible 检查）
	}
	if err != nil {
		logf("warn", "MCP %s tools/list_changed 重同步失败，保留上一代：%v", name, err)
		m.mu.Unlock()
		return
	}
	m.rebuildGenerationLocked(entry, tools)
	m.emitStatusLocked()
	m.emitToolsLocked()
	m.mu.Unlock()
}

// onLost server 进程意外退出：等关闭确认，确认了才重连（叠两个实例的后果不可逆）。
func (m *Manager) onLost(name string, client *mcpClient, reason string) {
	m.mu.Lock()
	entry, ok := m.servers[name]
	if !ok || entry.client != client || entry.disposed {
		m.mu.Unlock()
		return // 已换代或已移除：别的路径在处理
	}
	entry.client = nil
	if entry.retryTimer != nil {
		entry.retryTimer.Stop()
	}
	m.mu.Unlock()

	cr := client.close()

	m.mu.Lock()
	if !ok || entry.disposed {
		m.mu.Unlock()
		return
	}
	if !cr.CloseConfirmed {
		// 关闭未确认：宁可停住让用户重启，也不叠两个实例
		entry.blocking = true
		entry.setStatusLocked(func(s *mcpStatus) {
			s.State = "failed"
			s.Reason = "unclosed-generation"
			s.LastError = mcpRedactSecrets(entry.cfg.Env, reason+"；"+cr.CleanupError)
		})
		m.emitStatusLocked()
		m.mu.Unlock()
		logf("error", "MCP %s 关闭未确认，阻止重连与替换（需重启应用）：%s", name, cr.CleanupError)
		return
	}
	m.scheduleReconnectLocked(entry, reason)
	m.emitStatusLocked()
	m.mu.Unlock()
}

// scheduleReconnectLocked 退避调度。三条易错点：稳定运行 ≥ MaxDelayMs 才重置预算；
// failedAttempts > MaxAttempts 才放弃（允许正好 10 次）；放弃时注销工具。
func (m *Manager) scheduleReconnectLocked(entry *mcpServerEntry, errText string) {
	if entry.disposed {
		return
	}
	if !m.policy.Enabled {
		m.clearToolsLocked(entry)
		entry.setStatusLocked(func(s *mcpStatus) {
			s.State = "failed"
			s.Reason = "reconnect-disabled"
			s.LastError = errText
		})
		return
	}
	if !entry.connectedAt.IsZero() && m.now().Sub(entry.connectedAt) >= time.Duration(m.policy.MaxDelayMs)*time.Millisecond {
		entry.failedAttempts = 0 // 稳定运行后重置：闪断不算崩溃循环
	}
	entry.connectedAt = time.Time{}
	entry.failedAttempts++
	if entry.failedAttempts > m.policy.MaxAttempts {
		m.clearToolsLocked(entry)
		entry.setStatusLocked(func(s *mcpStatus) {
			s.State = "failed"
			s.Reason = "gave-up"
			s.Attempt = entry.failedAttempts - 1
			s.LastError = errText
		})
		logf("error", "MCP %s 连续 %d 次失败，放弃重连：%s", entry.name, m.policy.MaxAttempts, errText)
		return
	}
	delay := m.policy.delayFor(entry.failedAttempts)
	entry.setStatusLocked(func(s *mcpStatus) {
		s.State = "reconnecting"
		s.Attempt = entry.failedAttempts
		s.MaxAttempt = m.policy.MaxAttempts
		s.NextRetryAt = m.now().Add(delay).UnixMilli()
		s.LastError = errText
	})
	name := entry.name
	entry.retryTimer = time.AfterFunc(delay, func() { m.connectGeneration(name) })
}

func (m *Manager) clearToolsLocked(entry *mcpServerEntry) {
	entry.registry = nil
	entry.staleTools = nil
	entry.setStatusLocked(func(s *mcpStatus) { s.ToolCount = 0 })
	m.rebuildRoutesLocked()
}

// stopEntry 停止单个 server：关闭连接（等待确认）、注销工具、终止重同步循环。
func (m *Manager) stopEntry(entry *mcpServerEntry) {
	m.mu.Lock()
	client := entry.client
	entry.client = nil
	m.clearToolsLocked(entry)
	if entry.retryTimer != nil {
		entry.retryTimer.Stop()
		entry.retryTimer = nil
	}
	entry.setStatusLocked(func(s *mcpStatus) { s.State = "closed" })
	m.mu.Unlock()

	entry.quitOnce.Do(func() { close(entry.quit) })

	if client == nil {
		return
	}
	if cr := client.close(); !cr.CloseConfirmed {
		logf("error", "MCP %s 停止时关闭未确认：%s", entry.name, cr.CleanupError)
	}
}

// ===== 工具路由与调用 =====
// mcpRedactSecrets 失败路径脱敏（§10.4）：把该 server 配置 env 的值（长度 ≥ 8）从文本里替换掉。
// 只用于诊断/错误文本；成功结果不脱敏——那是模型真正要用的内容，乱替换会破坏功能。
func mcpRedactSecrets(env map[string]string, text string) string {
	for _, value := range env {
		if len(value) >= 8 && strings.Contains(text, value) {
			text = strings.ReplaceAll(text, value, "[redacted]")
		}
	}
	return text
}

// routeFor 公开名 → 路由信息（server / 原始名 / openWorld），前端留痕用。
func (m *Manager) routeFor(publicName string) (mcpRoute, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	route, ok := m.routes[publicName]
	return route, ok
}

// callTool 按公开名查表路由（绝不字符串反解），转发到对应 server 的原始名。
// 失败路径文本经 env 值脱敏（args 可能把密钥带进错误回显）。
func (m *Manager) CallTool(publicName string, args json.RawMessage) (CallResult, error) {
	m.mu.Lock()
	route, ok := m.routes[publicName]
	var client *mcpClient
	var env map[string]string
	state := ""
	if ok {
		if entry := m.servers[route.Server]; entry != nil {
			client = entry.client
			state = entry.status.State
			env = entry.cfg.Env
		}
	}
	m.mu.Unlock()
	if !ok {
		return CallResult{}, fmt.Errorf("未知 MCP 工具：%s（可能已被注销或配置变更）", publicName)
	}
	if client == nil {
		if state == "reconnecting" {
			return CallResult{}, fmt.Errorf("MCP server %s 正在重连，请稍后重试", route.Server)
		}
		return CallResult{}, fmt.Errorf("MCP server %s 未连接", route.Server)
	}
	result, err := client.CallTool(context.Background(), route.Raw, args)
	if err != nil {
		return CallResult{}, fmt.Errorf("%s", mcpRedactSecrets(env, err.Error()))
	}
	return result, nil
}

// ===== 快照与面板数据 =====
type SnapshotServer struct {
	Name        string             `json:"name"`
	State       string             `json:"state"`
	Reason      string             `json:"reason,omitempty"`
	ToolCount   int                `json:"toolCount"`
	Tools       []mcpPublicToolDef `json:"tools"`
	StaleTools  []string           `json:"staleTools,omitempty"`
	LastError   string             `json:"lastError,omitempty"`
	Attempt     int                `json:"attempt,omitempty"`
	MaxAttempt  int                `json:"maxAttempt,omitempty"`
	NextRetryAt int64              `json:"nextRetryAt,omitempty"`
	// Notes 是用户的「使用约定」原文，前端拼进系统提示词的 <mcp_server_notes> 块。
	Notes string `json:"notes,omitempty"`
}

type Snapshot struct {
	Enabled bool             `json:"enabled"`
	Servers []SnapshotServer `json:"servers"`
}

// snapshot 当前全量快照（工具 + 状态），MCPSnapshot 兜底拉取用。
func (m *Manager) Snapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) snapshotLocked() Snapshot {
	out := Snapshot{Enabled: m.enabled, Servers: []SnapshotServer{}}
	for _, entry := range m.servers {
		// notes 是用户手改 mcp.json 也可能进来的内容：写盘路径有长度校验，但热改文件
		// 不经过它——出快照前按 rune 截断，防止手滑把几万字塞进每次的系统提示词。
		notes := entry.cfg.Notes
		if runes := []rune(notes); len(runes) > mcpNotesMaxChars {
			notes = string(runes[:mcpNotesMaxChars])
		}
		s := SnapshotServer{
			Name:        entry.name,
			State:       entry.status.State,
			Reason:      entry.status.Reason,
			ToolCount:   entry.status.ToolCount,
			Tools:       entry.registry,
			StaleTools:  entry.staleTools,
			LastError:   entry.status.LastError,
			Attempt:     entry.status.Attempt,
			MaxAttempt:  entry.status.MaxAttempt,
			NextRetryAt: entry.status.NextRetryAt,
			Notes:       notes,
		}
		if s.Tools == nil {
			s.Tools = []mcpPublicToolDef{}
		}
		out.Servers = append(out.Servers, s)
	}
	return out
}

// rawToolsForPanel 工具勾选面板用：server 的原始工具清单（含描述/schema/hints）。
// 已连接直接取；未连接则临时起一个只读连接拉清单（不注册工具、不预留 namespace，
// 绝不触碰活动实例——未连接时本就没有活动实例）。
func (m *Manager) RawToolsForPanel(name string) ([]RemoteTool, error) {
	m.mu.Lock()
	entry, ok := m.servers[name]
	var cfg MCPServerConfig
	var client *mcpClient
	if ok {
		cfg = entry.cfg
		client = entry.client
	}
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("服务器 %s 不存在", name)
	}
	if client != nil {
		return clientToolsSorted(client), nil
	}
	if err := ValidateServer(name, cfg); err != nil {
		return nil, err
	}
	tmp := newMCPClient(name, cfg)
	if err := tmp.connect(context.Background()); err != nil {
		tmp.close()
		return nil, err
	}
	defer tmp.close()
	return clientToolsSorted(tmp), nil
}

func clientToolsSorted(c *mcpClient) []RemoteTool {
	tools := c.currentTools()
	out := make([]RemoteTool, 0, len(tools))
	for _, t := range tools {
		out = append(out, t)
	}
	return out
}

// ===== 重启与关闭 =====
// restartServer 用户点「重启」：清失败计数、重置状态、重新连接。
func (m *Manager) RestartServer(name string) error {
	m.mu.Lock()
	entry, ok := m.servers[name]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("服务器 %s 不存在", name)
	}
	if entry.disposed {
		m.mu.Unlock()
		return fmt.Errorf("服务器 %s 正在停止，请稍后重试", name)
	}
	if entry.blocking {
		m.mu.Unlock()
		return fmt.Errorf("上次连接未确认关闭，需重启应用后再试")
	}
	oldClient := entry.client
	entry.client = nil
	entry.failedAttempts = 0
	if entry.retryTimer != nil {
		entry.retryTimer.Stop()
		entry.retryTimer = nil
	}
	m.mu.Unlock()

	if oldClient != nil {
		oldClient.close()
	}
	m.ensureStarted(name)
	return nil
}

// closeAll 应用退出：并发关所有 server，总预算 8s；超时的靠 taskkill 兜底。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	entries := make([]*mcpServerEntry, 0, len(m.servers))
	for _, entry := range m.servers {
		entries = append(entries, entry)
	}
	m.mu.Unlock()
	done := make(chan struct{}, len(entries))
	for _, entry := range entries {
		go func(e *mcpServerEntry) {
			m.stopEntry(e)
			done <- struct{}{}
		}(entry)
	}
	deadline := time.After(mcpCloseAllBudget)
	for range entries {
		select {
		case <-done:
		case <-deadline:
			return // 超预算：剩余的由 killProcessTree / WaitDelay 兜底
		}
	}
}

// ===== 事件广播与初始配置 =====
func (m *Manager) emitTools() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.emitToolsLocked()
}

func (m *Manager) emitToolsLocked() {
	if m.emit == nil {
		return
	}
	m.emit("mcp-tools-changed", m.snapshotLocked())
}

func (m *Manager) emitStatusLocked() {
	if m.emit == nil {
		return
	}
	m.emit("mcp-status-changed", m.snapshotLocked())
}

// loadInitialConfig 启动时读盘建表（不自动启动进程——惰性，首次需要工具清单才起）。
func (m *Manager) LoadInitialConfig() error {
	cfg, err := ReadConfig()
	if err != nil {
		return err
	}
	m.ApplyConfig(cfg)
	return nil
}
