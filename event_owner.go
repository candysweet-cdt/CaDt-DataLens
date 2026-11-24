package main

// event_owner.go：流式事件的窗口归属路由（登记表在 internal/eventowner）。
//
// 本文件只剩两件与宿主有关的事：绑定方法怎么从 ctx 拿窗口名，以及命中归属后
// 怎么用窗口对象定向发射。表的淘汰策略与载荷取字段都是纯逻辑，随包下沉。
//
// 终端 / 命令 / 运行 / 浏览器标签 / 阅读搜索的输出事件天然带 id。前端在创建资源后
// 调用 RegisterEventOwner(kind, id)（调用方窗口经 ctx 归属）；引擎 emit 时按 id 查
// 归属窗口：命中则用该窗口对象发射（sender=窗口名，其他窗口丢弃）；未命中（创建竞态，
// 事件先于创建返回）仍走应用级广播，由消费端按 id 过滤——与收紧前行为一致。

import (
	"context"
	"strings"

	"datalens/internal/eventowner"
)

// RegisterEventOwner 登记资源 id 属于调用方窗口。
func (a *App) RegisterEventOwner(ctx context.Context, kind, id string) error {
	eventowner.Register(callerWindowName(ctx), kind, id)
	return nil
}

// UnregisterEventOwner 摘除登记（阅读搜索等一次性请求结束时调用）。
func (a *App) UnregisterEventOwner(ctx context.Context, kind, id string) error {
	eventowner.Unregister(kind, id)
	return nil
}

// routeOwnedEvent 按 id 找归属窗口定向发射；未命中回退应用广播。
func routeOwnedEvent(kind, event string, data any) {
	field := "id"
	if kind == "reading" {
		field = "requestID"
	}
	id := eventowner.PayloadString(data, field)
	if id != "" {
		if name, ok := eventowner.Lookup(kind, id); ok && name != "" {
			if st := winReg.Get(name); st != nil {
				if w := st.Window(); w != nil {
					w.EmitEvent(event, data)
					if strings.HasSuffix(event, "-exit") {
						eventowner.Unregister(kind, id)
					}
					return
				}
			}
		}
	}
	emitAppEvent(event, data)
}
