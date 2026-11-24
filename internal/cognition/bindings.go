package cognition

// bindings.go：Wails 绑定承载类型（原根 cognition_app.go 的壳）。
//
// 不叫 Service：本包已有 Service（认知索引引擎），重名会遮住引擎类型。
// App 匿名嵌入 *Bindings 后，三条 Cognition* 方法进 *App 方法集，前端 FQN
// 仍是 main.App.CognitionXxx（v3 无生成绑定，前端经 Call.ByName 动态解析；
// dev 模式需在 mock-backend.js 补同名 mock）。
//
// 壳里的 JSON 收发与根目录校验都是纯逻辑，一起搬进来；引擎实例由根在 NewApp
// 时经 NewBindings 注入日志钩子构造。

import (
	"encoding/json"
	"fmt"
	"os"
)

// Bindings 是认知索引的绑定承载类型。
type Bindings struct {
	engine *Service
}

// NewBindings 构造绑定承载类型；logf 为空时引擎静默。
func NewBindings(logf func(format string, args ...any)) *Bindings {
	return &Bindings{engine: New(Deps{Logf: logf})}
}

// validateRoot 校验工作区根存在且是目录（路径由前端传根目录，不拼相对片段）。
func validateRoot(ws string) error {
	info, err := os.Stat(ws)
	if err != nil {
		return fmt.Errorf("工作区根不可用：%w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("工作区根不是目录：%s", ws)
	}
	return nil
}

// CognitionRead 读索引（按 paths / labels / query 过滤；无过滤返回路径地图）。
func (b *Bindings) CognitionRead(workspace, reqJSON string) (string, error) {
	if err := validateRoot(workspace); err != nil {
		return "", err
	}
	var req ReadReq
	if reqJSON != "" {
		if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
			return "", fmt.Errorf("req 解析失败：%w", err)
		}
	}
	res, err := b.engine.Read(workspace, req)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// CognitionEdit 增删改条目 / 整卷替换元卷 / 维护作用域排除文件。
func (b *Bindings) CognitionEdit(workspace, reqJSON string) (string, error) {
	if err := validateRoot(workspace); err != nil {
		return "", err
	}
	var req EditReq
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return "", fmt.Errorf("req 解析失败：%w", err)
	}
	res, err := b.engine.Edit(workspace, req)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// CognitionStatus 治理报告（drift 四态、预算余量、卷指纹）。
func (b *Bindings) CognitionStatus(workspace string, verbose bool) (string, error) {
	if err := validateRoot(workspace); err != nil {
		return "", err
	}
	res, err := b.engine.Status(workspace, verbose)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "", err
	}
	return string(out), nil
}
