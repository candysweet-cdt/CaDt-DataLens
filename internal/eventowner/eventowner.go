package eventowner

// eventowner.go：流式事件的资源归属表（原在根 event_owner.go 的注册表部分）。
//
// 终端 / 命令 / 运行 / 浏览器标签 / 阅读搜索的输出事件天然带 id。前端在创建资源后
// 登记「这个 id 属于哪个窗口」；引擎 emit 时按 id 查归属窗口：命中则定向发射
// （sender=窗口名，其他窗口丢弃）；未命中（创建竞态，事件先于创建返回）仍走应用级
// 广播，由消费端按 id 过滤——与收紧前行为一致。
//
// 这里只管表本身（纯数据 + 淘汰策略 + 载荷取字段），窗口查找与发射留在根。

import (
	"strings"
	"sync"
)

// Limit 防无界增长：浏览器标签等没有天然退出事件的资源靠上限兜底。
const Limit = 8192

type key struct{ kind, id string }

var registry = struct {
	sync.RWMutex
	m     map[key]string
	order []key // 插入序：表满时按最老登记淘汰，而不是全表清空
}{m: make(map[key]string)}

// Register 登记资源 id 属于 owner（窗口名）。任一项为空时不登记。
func Register(owner, kind, id string) {
	kind = strings.TrimSpace(kind)
	id = strings.TrimSpace(id)
	if owner == "" || kind == "" || id == "" {
		return
	}
	k := key{kind, id}
	registry.Lock()
	defer registry.Unlock()
	if _, exists := registry.m[k]; !exists && len(registry.m) >= Limit {
		// 表满：淘汰最老的登记（对应资源大概率已消失，广播兜底会接管其事件），
		// 不能整表清空——那会把所有活跃归属一次性打回广播（审查 P2-6）。
		for len(registry.order) > 0 {
			oldest := registry.order[0]
			registry.order = registry.order[1:]
			if _, live := registry.m[oldest]; live {
				delete(registry.m, oldest)
				break
			}
		}
	}
	if _, exists := registry.m[k]; !exists {
		registry.order = append(registry.order, k)
	}
	registry.m[k] = owner
}

// Unregister 摘除登记（阅读搜索等一次性请求结束时调用）。
func Unregister(kind, id string) {
	registry.Lock()
	delete(registry.m, key{strings.TrimSpace(kind), strings.TrimSpace(id)})
	registry.Unlock()
}

// Lookup 查资源 id 的归属窗口名；未登记返回 ok=false。
func Lookup(kind, id string) (string, bool) {
	registry.RLock()
	defer registry.RUnlock()
	owner, ok := registry.m[key{kind, id}]
	return owner, ok
}

// Len 返回当前登记条数（测试与诊断用）。
func Len() int {
	registry.RLock()
	defer registry.RUnlock()
	return len(registry.m)
}

// Reset 清空登记表（测试用）。
func Reset() {
	registry.Lock()
	registry.m = make(map[key]string)
	registry.order = nil
	registry.Unlock()
}

// PayloadString 从事件载荷里取字符串字段（各引擎载荷为 map[string]string 或
// map[string]interface{}，个别资源类型实现 GetID）。
func PayloadString(data any, field string) string {
	switch v := data.(type) {
	case map[string]string:
		return v[field]
	case map[string]interface{}:
		if s, ok := v[field].(string); ok {
			return s
		}
	case interface{ GetID() string }:
		if field == "id" {
			return v.GetID()
		}
	}
	return ""
}
