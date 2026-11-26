package aitransport

// 请求节流：让 429 尽量不发生，而不是发生了再重试。
//
// 为什么需要它：并发面比看上去大得多——主会话 × 会话数 + 最多 20 个子代理
// （ai-subagents） + 1 个自动审批分类器，全部落在同一个 baseURL+model 上；而 Go 侧
// 原先没有任何速率控制，只有「收到 429 之后」才退避重试（http.go 的 aiRetryDelay）。
//
// 两层：
//  1. RPM 滑动窗口：按 baseURL|model 记最近 60 秒的请求时刻，超阈值就排队。
//  2. 429 冻结：服务端用 Retry-After 明确说了「X 秒后再来」，冻结期内同 key 的请求
//     直接排队、不再往前撞。这层不需要用户配置，收益却最大。
//
// 与重试的关系是**叠加，不是替换**：限流器管事前预防，aiRetryDelay 管事后补救。
// 限流器覆盖不了网关侧配额抖动、网络错误与 5xx，所以重试逻辑一律保留。
//
// 已知边界：key 只取 baseURL+model，同一 URL 上用两个 key 会被合并计数（保守方向，
// 只会更少撞墙）；纯 RPM 不统计 token，TPM 需要「预估 + usage 回填」两段链路，留待二期。

import (
	"context"
	"strings"
	"sync"
	"time"
)

// rateWindow 是 RPM 的统计窗口。服务商的 rpm 是分钟窗，所以固定 60 秒。
const rateWindow = time.Minute

// rateQueuePoll 是排队重试的最小粒度：既是 ctx 的响应间隔，也是看门狗的喂食间隔。
const rateQueuePoll = 250 * time.Millisecond

// 排队原因。两种等待的时间尺度差三个数量级，前端文案必须分开，
// 否则「服务商配额用尽 9.9 小时」会被写成「RPM 限流」，用户只会去删请求而不是等配额。
const (
	RateLimitKindRPM    = "rpm"
	RateLimitKindFrozen = "frozen"
)

type rateGate struct {
	// stamps 是窗口内的请求时刻，按时间递增（追加顺序天然有序）。
	stamps []time.Time
	// frozenUntil 是 429 回灌的冻结到期时刻。
	frozenUntil time.Time
}

type rateLimiter struct {
	mu    sync.Mutex
	gates map[string]*rateGate
}

var aiRateLimiter = &rateLimiter{gates: map[string]*rateGate{}}

// rateKey 决定「算作同一个配额的请求」：同一个 baseURL（协议+主机+路径）上的同一个模型。
// 大小写归一避免 BaseURL 尾斜杠/大小写差异把计数拆成两份。
func rateKey(cfg Config) string {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	return strings.ToLower(base) + "|" + strings.TrimSpace(cfg.Model)
}

// tryAcquire 判断此刻能否发请求。返回等待时长、是否放行、以及排队原因（放行时为空）。
// 放行时会记一次请求时刻（仅当 rpm > 0——不限速就不留账，避免无意义的内存增长）。
func (l *rateLimiter) tryAcquire(key string, rpm int) (time.Duration, bool, string) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	gate := l.gates[key]
	if gate == nil {
		gate = &rateGate{}
		l.gates[key] = gate
	}
	if now.Before(gate.frozenUntil) {
		return gate.frozenUntil.Sub(now), false, RateLimitKindFrozen
	}
	if rpm > 0 {
		cutoff := now.Add(-rateWindow)
		kept := gate.stamps[:0]
		for _, at := range gate.stamps {
			if at.After(cutoff) {
				kept = append(kept, at)
			}
		}
		gate.stamps = kept
		if len(gate.stamps) >= rpm {
			// 最早那次请求滑出窗口就能再发一次
			return gate.stamps[0].Add(rateWindow).Sub(now), false, RateLimitKindRPM
		}
		gate.stamps = append(gate.stamps, now)
	}
	return 0, true, ""
}

// freezeUntil 由 429 分支回灌：把该 key 的窗口冻结到服务端要求的时刻。
// 只延后不提前（多次 429 取最晚的那个）。
func (l *rateLimiter) freezeUntil(key string, until time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	gate := l.gates[key]
	if gate == nil {
		gate = &rateGate{}
		l.gates[key] = gate
	}
	if until.After(gate.frozenUntil) {
		gate.frozenUntil = until
	}
}

// resetRateLimiter 只给测试用：清空所有 key 的窗口与冻结态。
func resetRateLimiter() {
	aiRateLimiter = &rateLimiter{gates: map[string]*rateGate{}}
}

// acquireSlot 在真正发请求前拿名额；被限流时排队等待。
//
// 三个必须遵守的点：
//   - 等待中必须持续 touch 看门狗，否则空闲超时（types.go 的 ErrIdleTimeout，默认 300s、
//     可在设置里配置）会把「排队中」的请求当成卡死直接杀掉；
//   - 等待必须能响应 ctx，否则用户点停止之后请求还会在队列里等着发出去；
//   - 排队时长要通知前端（ai-queue），否则用户看到的是纯空转，比 429 更像卡死。
func acquireSlot(ctx context.Context, cfg Config, id string, emit Emitter, touch func()) error {
	key := rateKey(cfg)
	announced := false
	lastKind := ""
	clear := func() {
		if announced && emit != nil {
			emit(EventQueue, QueuePayload{Id: id})
		}
	}
	for {
		wait, ok, kind := aiRateLimiter.tryAcquire(key, cfg.RPMLimit)
		if ok {
			clear()
			return nil
		}
		if wait < rateQueuePoll {
			wait = rateQueuePoll
		}
		// 排队原因会变：429 冻结到期后可能仍卡在 RPM 窗口里。kind 一变就重发，
		// 否则用户会一直看到「配额用尽」直到请求被放行。
		if !announced || kind != lastKind {
			announced = true
			lastKind = kind
			if emit != nil {
				reason := "本地限流排队"
				if kind == RateLimitKindFrozen {
					reason = "服务商配额已用尽"
				}
				emit(EventQueue, QueuePayload{
					Id:     id,
					WaitMs: int(wait.Milliseconds()),
					Reason: reason,
					Kind:   kind,
				})
			}
		}
		step := wait
		if step > time.Second {
			step = time.Second
		}
		select {
		case <-ctx.Done():
			clear()
			return ctx.Err()
		case <-time.After(step):
			if touch != nil {
				touch()
			}
		}
	}
}
