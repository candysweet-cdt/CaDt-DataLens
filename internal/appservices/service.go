// Package appservices：插件声明的后台服务托管——统一注册、自启、健康检查、停止与退出清理。
// 引擎不 import main；进程启停复用 internal/procctl（取消即杀整棵进程树），
// 防黑窗走 internal/executil；平台相关符号不出现在本包平台无关文件里。
package appservices

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	StateStopped  = "stopped"
	StateStarting = "starting"
	StateRunning  = "running"
	StateFailed   = "failed"

	defaultPollIntervalMs = 3000
	defaultLogCapBytes    = 256 << 10
	healthFailThreshold   = 5
	procIDPrefix          = "appsvc:"
)

var serviceIDRule = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// Spec 是插件声明的一个后台服务。HealthURL 为空时只按进程存活判定健康。
type Spec struct {
	ID             string   `json:"id"`
	Exe            string   `json:"exe"`
	Args           []string `json:"args"`
	Cwd            string   `json:"cwd"`
	HealthURL      string   `json:"healthURL,omitempty"`
	AutoStart      bool     `json:"autoStart,omitempty"`
	PollIntervalMs int      `json:"pollIntervalMs,omitempty"`
	LogCapBytes    int      `json:"logCapBytes,omitempty"`
}

// Status 是一次查询的状态快照。StartedAt 为 Unix 毫秒，0 表示未启动。
type Status struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	Pid       int    `json:"pid"`
	LastError string `json:"lastError,omitempty"`
	StartedAt int64  `json:"startedAt,omitempty"`
	HealthOK  bool   `json:"healthOK"`
}

type service struct {
	spec         Spec
	mu           sync.Mutex
	state        string
	pid          int
	lastError    string
	startedAt    int64
	healthOK     bool
	stopping     bool
	healthFailed bool // 健康检查判死并主动杀进程：watchProcess 不要用退出码覆盖原因
	logs         []string
	logBytes     int
	healthCancel func()
}

func newService(spec Spec) *service {
	return &service{spec: spec, state: StateStopped, healthOK: spec.HealthURL == ""}
}

// Registry 是服务注册表。Sync 是前端唯一真源推送入口；Start/Stop 供设置页手动操作。
type Registry struct {
	mu       sync.RWMutex
	services map[string]*service
	client   *http.Client
}

func New() *Registry {
	return &Registry{
		services: map[string]*service{},
		client:   &http.Client{Timeout: healthTimeout},
	}
}

func normalizeSpec(spec Spec) (Spec, error) {
	spec.ID = strings.TrimSpace(spec.ID)
	spec.Exe = strings.TrimSpace(spec.Exe)
	spec.Cwd = strings.TrimSpace(spec.Cwd)
	spec.HealthURL = strings.TrimSpace(spec.HealthURL)
	if !serviceIDRule.MatchString(spec.ID) {
		return spec, fmt.Errorf("服务 id 无效：%q", spec.ID)
	}
	if spec.Exe == "" {
		return spec, fmt.Errorf("服务 %s 缺少 exe", spec.ID)
	}
	if len(spec.Args) > 128 {
		return spec, fmt.Errorf("服务 %s 参数超过 128 个", spec.ID)
	}
	if spec.HealthURL != "" && !strings.HasPrefix(spec.HealthURL, "http://") && !strings.HasPrefix(spec.HealthURL, "https://") {
		return spec, fmt.Errorf("服务 %s 的 healthURL 仅支持 http/https", spec.ID)
	}
	if spec.PollIntervalMs <= 0 {
		spec.PollIntervalMs = defaultPollIntervalMs
	}
	if spec.PollIntervalMs < 500 {
		spec.PollIntervalMs = 500
	}
	if spec.LogCapBytes <= 0 {
		spec.LogCapBytes = defaultLogCapBytes
	}
	return spec, nil
}

// Register 新增或替换一个服务声明；重复 id 返回错误（批量同步请用 Sync）。
func (r *Registry) Register(spec Spec) error {
	normalized, err := normalizeSpec(spec)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.services[normalized.ID]; exists {
		return fmt.Errorf("服务 %s 已注册", normalized.ID)
	}
	r.services[normalized.ID] = newService(normalized)
	return nil
}

// Sync 用当前声明覆盖注册表：不再声明的服务停止并移除，spec 变化的服务重启。
// 插件每次加载完成后调用一次，保证禁用/卸载插件的服务不会残留。
func (r *Registry) Sync(specs []Spec) error {
	wanted := map[string]Spec{}
	for _, raw := range specs {
		spec, err := normalizeSpec(raw)
		if err != nil {
			return err
		}
		wanted[spec.ID] = spec
	}

	r.mu.Lock()
	for id, svc := range r.services {
		if _, ok := wanted[id]; !ok {
			r.stopLocked(svc)
			delete(r.services, id)
			continue
		}
		svc.mu.Lock()
		changed := !specEqual(svc.spec, wanted[id])
		svc.mu.Unlock()
		if changed {
			r.stopLocked(svc)
			svc = newService(wanted[id])
			r.services[id] = svc
		}
	}
	for id, spec := range wanted {
		if _, ok := r.services[id]; !ok {
			r.services[id] = newService(spec)
		}
	}
	auto := make([]*service, 0, len(r.services))
	for _, svc := range r.services {
		if svc.spec.AutoStart {
			auto = append(auto, svc)
		}
	}
	r.mu.Unlock()

	for _, svc := range auto {
		if err := r.start(svc); err != nil {
			logf("warn", "后台服务 %s 自启失败：%v", svc.spec.ID, err)
		}
	}
	return nil
}

func specEqual(a, b Spec) bool {
	if a.Exe != b.Exe || a.Cwd != b.Cwd || a.HealthURL != b.HealthURL || a.AutoStart != b.AutoStart {
		return false
	}
	if len(a.Args) != len(b.Args) {
		return false
	}
	for i := range a.Args {
		if a.Args[i] != b.Args[i] {
			return false
		}
	}
	return true
}

func (r *Registry) lookup(id string) (*service, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	svc, ok := r.services[strings.TrimSpace(id)]
	if !ok {
		return nil, fmt.Errorf("服务 %s 未注册", id)
	}
	return svc, nil
}

// Start 启动一个服务；已在运行或启动中时幂等返回。
func (r *Registry) Start(id string) error {
	svc, err := r.lookup(id)
	if err != nil {
		return err
	}
	return r.start(svc)
}

// Stop 停止一个服务。
func (r *Registry) Stop(id string) error {
	svc, err := r.lookup(id)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopLocked(svc)
	return nil
}

// Status 返回单个服务的状态快照。
func (r *Registry) Status(id string) (Status, bool) {
	svc, err := r.lookup(id)
	if err != nil {
		return Status{}, false
	}
	return svc.snapshot(), true
}

// List 返回所有服务的状态快照（按 id 排序由调用方决定，这里按注册顺序）。
func (r *Registry) List() []Status {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Status, 0, len(r.services))
	for _, svc := range r.services {
		out = append(out, svc.snapshot())
	}
	return out
}

// Logs 返回服务的日志行快照。
func (r *Registry) Logs(id string) []string {
	svc, err := r.lookup(id)
	if err != nil {
		return nil
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	return append([]string(nil), svc.logs...)
}

// StartAll 启动所有声明了 autoStart 的服务。
func (r *Registry) StartAll() {
	r.mu.RLock()
	auto := make([]*service, 0, len(r.services))
	for _, svc := range r.services {
		if svc.spec.AutoStart {
			auto = append(auto, svc)
		}
	}
	r.mu.RUnlock()
	for _, svc := range auto {
		if err := r.start(svc); err != nil {
			logf("warn", "后台服务 %s 自启失败：%v", svc.spec.ID, err)
		}
	}
}

// StopAll 停止所有服务（应用退出时调用）。
func (r *Registry) StopAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, svc := range r.services {
		r.stopLocked(svc)
	}
}

func (s *service) snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Status{
		ID: s.spec.ID, State: s.state, Pid: s.pid,
		LastError: s.lastError, StartedAt: s.startedAt, HealthOK: s.healthOK,
	}
}

// 供测试注入时钟间隔，避免真实等待。
var healthTimeout = 2 * time.Second
