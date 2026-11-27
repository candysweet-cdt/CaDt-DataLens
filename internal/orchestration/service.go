// service.go：Wails 绑定层。Service 只放需要暴露给前端的动作；内部判定都在 Engine。
//
// 工作区鉴权来自绑定 context（可信窗口），不读前端传参；AI 工具分支不能选择
// 自己看/控制哪个工作区的编排。
package orchestration

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Deps 里与 Wails 上下文有关的两个函数由根包注入，internal 包不 import Wails。
type CallDeps struct {
	WorkspaceForCall func(context.Context) string
	WindowForCall    func(context.Context) string
}

var (
	Default  *Engine
	callDeps CallDeps
)

// Configure 由 host_wiring 调用：构造全局引擎并注入窗口上下文解析。
func Configure(root string, deps Deps, calls CallDeps) *Engine {
	callDeps = calls
	Default = NewEngine(root, deps)
	return Default
}

func engine() (*Engine, error) {
	if Default == nil {
		return nil, fmt.Errorf("编排引擎尚未初始化")
	}
	return Default, nil
}

// StartDefault / StopDefault 由应用生命周期调用；不暴露成 Wails 绑定。
func StartDefault() error {
	if Default == nil {
		return fmt.Errorf("编排引擎尚未初始化")
	}
	return Default.Start()
}

func StopDefault() {
	if Default != nil {
		Default.Stop()
	}
}

func callerWorkspace(ctx context.Context) string {
	if callDeps.WorkspaceForCall == nil {
		return ""
	}
	return strings.TrimSpace(callDeps.WorkspaceForCall(ctx))
}

func callerWindow(ctx context.Context) string {
	if callDeps.WindowForCall == nil {
		return ""
	}
	return callDeps.WindowForCall(ctx)
}

// requireWorkspace 对编排的读写一律 fail-closed：多工作区 harness 窗口没有单一
// 窗口工作区时，宁可不显示编排，也不能把其他仓库的编排暴露给本窗口。
func requireWorkspace(ctx context.Context) (string, error) {
	ws := callerWorkspace(ctx)
	if strings.TrimSpace(ws) == "" {
		return "", fmt.Errorf("当前窗口没有绑定工作区；编排需要单工作区窗口")
	}
	return ws, nil
}

// Service 是 Wails 绑定入口；只在这里放导出方法（每个都进绑定基线）。
type Service struct{}

func (s *Service) OrchestrationPlanPreview(ctx context.Context, reqJSON string) (PlanPreview, error) {
	e, err := engine()
	if err != nil {
		return PlanPreview{}, err
	}
	var req PlanRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return PlanPreview{}, fmt.Errorf("计划格式无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return PlanPreview{}, err
	}
	if strings.TrimSpace(req.Workspace) == "" {
		req.Workspace = ws
	} else if cleanAbs(req.Workspace) != cleanAbs(ws) {
		return PlanPreview{}, fmt.Errorf("只能为当前窗口的工作区创建编排")
	}
	return e.Preview(req), nil
}

func (s *Service) OrchestrationCreate(ctx context.Context, reqJSON string) (CreateResult, error) {
	e, err := engine()
	if err != nil {
		return CreateResult{}, err
	}
	var req PlanRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return CreateResult{}, fmt.Errorf("计划格式无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return CreateResult{}, err
	}
	if strings.TrimSpace(req.Workspace) == "" {
		req.Workspace = ws
	} else if cleanAbs(req.Workspace) != cleanAbs(ws) {
		return CreateResult{}, fmt.Errorf("只能为当前窗口的工作区创建编排")
	}
	return e.Create(req, callerWindow(ctx))
}

func (s *Service) OrchestrationList(ctx context.Context) ([]Summary, error) {
	e, err := engine()
	if err != nil {
		return nil, err
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return nil, err
	}
	return e.List(ws), nil
}

func (s *Service) OrchestrationGet(ctx context.Context, id string) (*StatusView, error) {
	e, err := engine()
	if err != nil {
		return nil, err
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return nil, err
	}
	return e.Get(strings.TrimSpace(id), ws)
}

func (s *Service) OrchestrationClaimBatch(ctx context.Context, reqJSON string) (ClaimResponse, error) {
	e, err := engine()
	if err != nil {
		return ClaimResponse{}, err
	}
	var req struct {
		OrchestrationID string `json:"orchestrationId"`
		BatchID         string `json:"batchId"`
		ExpectedAttempt int    `json:"expectedAttempt"`
	}
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return ClaimResponse{}, fmt.Errorf("认领参数无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return ClaimResponse{}, err
	}
	return e.ClaimBatch(req.OrchestrationID, req.BatchID, req.ExpectedAttempt, callerWindow(ctx), ws), nil
}

func (s *Service) OrchestrationStartBatch(ctx context.Context, reqJSON string) (StartResponse, error) {
	e, err := engine()
	if err != nil {
		return StartResponse{}, err
	}
	var req StartRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return StartResponse{}, fmt.Errorf("起轮参数无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return StartResponse{}, err
	}
	return e.StartBatch(req, callerWindow(ctx), ws)
}

func (s *Service) OrchestrationAbortStart(ctx context.Context, reqJSON string) error {
	e, err := engine()
	if err != nil {
		return err
	}
	var req AbortRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return fmt.Errorf("回滚参数无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return err
	}
	return e.AbortStart(req, callerWindow(ctx), ws)
}

// OrchestrationReport 接收 AI 会话回报；执行票据由前端运行时自动附加，不进模型参数。
func (s *Service) OrchestrationReport(token, payloadJSON string) (ReportResult, error) {
	e, err := engine()
	if err != nil {
		return ReportResult{}, err
	}
	return e.Report(strings.TrimSpace(token), payloadJSON)
}

// OrchestrationAuthorizeWrite 受控写路径的 Go 侧所有权闸。
func (s *Service) OrchestrationAuthorizeWrite(token, path string) (WriteResult, error) {
	e, err := engine()
	if err != nil {
		return WriteResult{}, err
	}
	return e.AuthorizeWrite(strings.TrimSpace(token), path), nil
}

func (s *Service) OrchestrationTurnEvent(ctx context.Context, reqJSON string) error {
	e, err := engine()
	if err != nil {
		return err
	}
	var req TurnEventRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return fmt.Errorf("回合事件格式无效：%w", err)
	}
	return e.TurnEvent(req)
}

// OrchestrationControl 仲裁者控制动作；会话身份由前端运行时附加，模型不能自填。
func (s *Service) OrchestrationControl(ctx context.Context, reqJSON string) (ControlResult, error) {
	e, err := engine()
	if err != nil {
		return ControlResult{}, err
	}
	var req ControlRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return ControlResult{}, fmt.Errorf("控制参数无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return ControlResult{}, err
	}
	if _, err := e.Get(req.OrchestrationID, ws); err != nil {
		return ControlResult{}, err
	}
	return e.Control(req, req.ArbiterSessionID)
}

func (s *Service) OrchestrationUserControl(ctx context.Context, reqJSON string) (ControlResult, error) {
	e, err := engine()
	if err != nil {
		return ControlResult{}, err
	}
	var req ControlRequest
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return ControlResult{}, fmt.Errorf("控制参数无效：%w", err)
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return ControlResult{}, err
	}
	return e.UserControl(req, ws)
}

func (s *Service) OrchestrationDelete(ctx context.Context, id string) error {
	e, err := engine()
	if err != nil {
		return err
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return err
	}
	return e.Delete(strings.TrimSpace(id), ws)
}

// OrchestrationSetArbiter 前端建好新仲裁会话后回填（交接）。
func (s *Service) OrchestrationSetArbiter(ctx context.Context, id, sessionID, reason string) error {
	e, err := engine()
	if err != nil {
		return err
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return err
	}
	if _, err := e.Get(strings.TrimSpace(id), ws); err != nil {
		return err
	}
	return e.SetArbiter(strings.TrimSpace(id), strings.TrimSpace(sessionID), reason)
}

// OrchestrationReportArbiterUsage 上报仲裁者上下文使用量（来自 usage 事实 + 模型窗口配置）。
func (s *Service) OrchestrationReportArbiterUsage(ctx context.Context, id, sessionID string, generation int, used, window int64) error {
	e, err := engine()
	if err != nil {
		return err
	}
	ws, err := requireWorkspace(ctx)
	if err != nil {
		return err
	}
	if _, err := e.Get(strings.TrimSpace(id), ws); err != nil {
		return err
	}
	e.ReportArbiterUsage(strings.TrimSpace(id), strings.TrimSpace(sessionID), generation, used, window)
	return nil
}
