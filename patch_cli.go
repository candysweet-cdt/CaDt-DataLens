package main

// 补丁命令行：不启动 WebView、不需要 AI，直接检查 / 应用 / 撤销。
//
//	CaDt-DataLens.exe --check-patch  x.patch [--dir D:\repo] [--json]
//	CaDt-DataLens.exe --apply-patch  x.patch [--dir D:\repo] [--partial] --yes
//	CaDt-DataLens.exe --revert-patch <id> [--dir D:\repo] --yes
//
// 退出码：0 成功；1 有文件未应用；2 参数/路径错误；3 内部错误；4 缺少 --yes；5 回滚失败。

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type patchCLIOptions struct {
	Action      string // check | apply | revert
	PatchPath   string
	Dir         string
	Only        []string
	Partial     bool
	Yes         bool
	JSON        bool
	IgnoreWS    bool
	AllowOffset bool
	OnConflict  string
	RevertID    string
}

func parsePatchArgs(args []string) (*patchCLIOptions, bool, error) {
	action := ""
	for _, a := range args {
		switch a {
		case "--check-patch":
			action = "check"
		case "--apply-patch":
			action = "apply"
		case "--revert-patch":
			action = "revert"
		}
		if action != "" {
			break
		}
	}
	if action == "" {
		return nil, false, nil
	}
	opts := &patchCLIOptions{Action: action, OnConflict: "abort"}
	var positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s 缺少参数", a)
			}
			i++
			return args[i], nil
		}
		switch {
		case a == "--check-patch" || a == "--apply-patch" || a == "--revert-patch":
			// 已识别
		case a == "--dir" || a == "-d":
			v, err := next()
			if err != nil {
				return nil, true, err
			}
			opts.Dir = v
		case a == "--only":
			v, err := next()
			if err != nil {
				return nil, true, err
			}
			for _, part := range strings.Split(v, ",") {
				if p := strings.TrimSpace(part); p != "" {
					opts.Only = append(opts.Only, p)
				}
			}
		case a == "--on-conflict":
			v, err := next()
			if err != nil {
				return nil, true, err
			}
			opts.OnConflict = v
		case a == "--json":
			opts.JSON = true
		case a == "--partial":
			opts.Partial = true
		case a == "--atomic":
			opts.Partial = false
		case a == "--yes" || a == "-y":
			opts.Yes = true
		case a == "--ignore-whitespace":
			opts.IgnoreWS = true
		case a == "--allow-offset":
			opts.AllowOffset = true
		case strings.HasPrefix(a, "-"):
			return nil, true, fmt.Errorf("未知参数：%s", a)
		default:
			positional = append(positional, a)
		}
	}
	if len(positional) == 0 {
		return nil, true, fmt.Errorf("缺少补丁文件路径")
	}
	opts.PatchPath = positional[0]
	if action == "revert" {
		opts.RevertID = filepath.Base(opts.PatchPath)
		if strings.HasSuffix(strings.ToLower(opts.RevertID), ".patch") {
			opts.RevertID = strings.TrimSuffix(opts.RevertID, filepath.Ext(opts.RevertID))
		}
	}
	return opts, true, nil
}

// patchWriter 选一个真正能写的输出：GUI 子系统下 stdout 有时是坏句柄，
// 这时退回 stderr，保证命令行不会"静默无输出"。
func patchWriter() io.Writer {
	if patchStdoutUsable() {
		return os.Stdout
	}
	return os.Stderr
}

func pout(format string, a ...any) {
	fmt.Fprintf(patchWriter(), format, a...)
}

func runPatchCommand(opts *patchCLIOptions) int {
	switch opts.Action {
	case "check", "apply":
		return patchCLIApply(opts)
	case "revert":
		return patchCLIRevert(opts)
	}
	return 2
}

type patchCLIReport struct {
	Mode       string            `json:"mode"`
	Action     string            `json:"action"`
	Root       string            `json:"root"`
	Patch      string            `json:"patch"`
	Added      int               `json:"added"`
	Removed    int               `json:"removed"`
	Applicable int               `json:"applicable"`
	Total      int               `json:"total"`
	Files      []patchCLIFileOut `json:"files"`
	Applied    int               `json:"applied,omitempty"`
	Skipped    int               `json:"skipped,omitempty"`
	Code       string            `json:"code,omitempty"`
	Message    string            `json:"message,omitempty"`
}

type patchCLIFileOut struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Hint    string `json:"hint,omitempty"`
}

func patchCLIApply(opts *patchCLIOptions) int {
	root := strings.TrimSpace(opts.Dir)
	if root == "" {
		root = filepath.Dir(opts.PatchPath)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "无法解析目录：%v\n", err)
		return 2
	}
	text, err := readPatchFileText(opts.PatchPath, patchMaxTextBytes)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", patchErrorText(err))
		return 2
	}
	doc, err := parsePatchText(text)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", patchErrorText(err))
		return 2
	}
	optsPlan := patchPlanOptions{
		AllowOffset:      opts.AllowOffset,
		IgnoreWhitespace: opts.IgnoreWS,
		StripLevel:       -1,
		External:         true,
	}
	if sc := loadPatchSidecar(patchStoreRoot(absRoot), sha256Hex([]byte(text))); sc != nil {
		optsPlan.BaseHashes = sc.Files
	}
	plan, perr := buildPatchPlan(doc, absRoot, newPatchRunID(""), filepath.Base(opts.PatchPath), opts.PatchPath, optsPlan)
	if perr != nil {
		fmt.Fprintf(os.Stderr, "%s\n", patchErrorText(perr))
		return 2
	}
	putPatchPlan(plan)

	mode := "atomic"
	if opts.Partial {
		mode = "partial"
	}
	report := patchCLIReport{Mode: mode, Action: opts.Action, Root: absRoot, Patch: opts.PatchPath, Added: doc.Added, Removed: doc.Removed, Total: len(plan.Files)}
	for _, f := range plan.Files {
		fo := patchCLIFileOut{Path: f.RelPath, Status: f.Status, Reason: f.Reason, Added: f.Added, Removed: f.Removed}
		if f.Status == "ok" {
			report.Applicable++
		}
		fo.Hint = patchHintFor(f.Status, f.Reason)
		report.Files = append(report.Files, fo)
	}

	if opts.Action == "check" || !opts.Yes {
		if opts.JSON {
			return patchCLIExit(report, boolToCode(report.Applicable == len(plan.Files)), true)
		}
		printPatchReport(report, !opts.Yes)
		if !opts.Yes && opts.Action == "apply" {
			pout("\n未写入任何文件。确认无误后加 --yes 真正应用。")
			return 4
		}
		if report.Applicable == len(plan.Files) {
			return 0
		}
		return 1
	}

	res, err := applyPatchPlan(plan, opts.Only, nil, mode)
	if err != nil {
		if opts.JSON {
			report.Code = patchErrBackend
			report.Message = patchErrorText(err)
			return patchCLIExit(report, 3, false)
		}
		fmt.Fprintf(os.Stderr, "%s\n", patchErrorText(err))
		return 3
	}
	if res.Code != "" {
		report.Code = res.Code
	}
	if res.Message != "" {
		report.Message = res.Message
	}
	report.Applied = res.Applied
	report.Skipped = res.Skipped
	report.Added = res.Added
	report.Removed = res.Removed
	// 用应用结果覆盖文件状态
	statusByPath := map[string]PatchFileResult{}
	for _, f := range res.Files {
		statusByPath[strings.ToLower(f.RelPath)] = f
	}
	for i := range report.Files {
		if r, ok := statusByPath[strings.ToLower(report.Files[i].Path)]; ok {
			report.Files[i].Status = r.Status
			if r.Reason != "" {
				report.Files[i].Reason = r.Reason
			}
			report.Files[i].Hint = patchHintFor(r.Status, r.Reason)
		}
	}
	code := 0
	if res.Code == patchErrRollback {
		code = 5
	} else if res.Applied == 0 || res.Skipped > 0 {
		code = 1
	}
	if opts.JSON {
		return patchCLIExit(report, code, false)
	}
	printPatchResult(report, res)
	return code
}

func boolToCode(ok bool) int {
	if ok {
		return 0
	}
	return 1
}

func patchCLIExit(report patchCLIReport, code int, preview bool) int {
	b, _ := json.MarshalIndent(report, "", "  ")
	pout("%s\n", string(b))
	if code == 4 && !preview {
		return 4
	}
	return code
}

func patchCLIRevert(opts *patchCLIOptions) int {
	root := strings.TrimSpace(opts.Dir)
	if root == "" {
		root, _ = os.Getwd()
	}
	if !opts.Yes {
		pout("撤销会还原该补丁应用前的文件内容。确认后加 --yes。\n")
		return 4
	}
	res, err := revertPatchByID(root, opts.RevertID, opts.OnConflict)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", patchErrorText(err))
		return 3
	}
	if opts.JSON {
		b, _ := json.MarshalIndent(res, "", "  ")
		pout("%s\n", string(b))
	} else if res.OK {
		pout("已撤销补丁 %s，恢复 %d 个文件：\n", opts.RevertID, len(res.Files))
		for _, f := range res.Files {
			pout("  %s\n", f)
		}
	} else {
		fmt.Fprintf(os.Stderr, "%s\n", res.Message)
	}
	if res.OK {
		return 0
	}
	if res.Code == patchErrConcurrent {
		return 1
	}
	return 3
}

func printPatchReport(r patchCLIReport, preview bool) {
	pout("补丁：%s\n目标目录：%s\n模式：%s\n", r.Patch, r.Root, r.Mode)
	pout("文件 %d 个，可应用 %d 个（+%d −%d）\n\n", r.Total, r.Applicable, r.Added, r.Removed)
	for _, f := range r.Files {
		mark := "✓"
		if f.Status != "ok" {
			mark = "✗"
		}
		pout("%s %-40s %s", mark, f.Path, statusLabel(f.Status))
		if f.Reason != "" {
			pout(" — %s", f.Reason)
		}
		pout("\n")
		if f.Hint != "" && f.Status != "ok" {
			pout("    → %s\n", f.Hint)
		}
	}
	if preview {
		pout("\n")
	}
}

func printPatchResult(r patchCLIReport, res *PatchApplyResult) {
	if res.Applied > 0 {
		pout("已应用 %d 个文件（+%d −%d）\n", res.Applied, res.Added, res.Removed)
	}
	if res.Skipped > 0 {
		pout("跳过 %d 个文件\n", res.Skipped)
	}
	if res.Applied == 0 && res.Skipped == 0 {
		pout("未应用任何文件：磁盘未发生变更\n")
	}
	for _, f := range res.Files {
		mark := map[string]string{"applied": "✓", "skipped": "⚠", "failed": "✗", "notapplied": "·"}[f.Status]
		if mark == "" {
			mark = "·"
		}
		pout("%s %-40s %s", mark, f.RelPath, statusLabel(f.Status))
		if f.Reason != "" {
			pout(" — %s", f.Reason)
		}
		pout("\n")
	}
	if res.RevertID != "" && res.Applied > 0 {
		pout("\n撤销：CaDt-DataLens.exe --revert-patch %s --dir \"%s\" --yes\n", res.RevertID, r.Root)
	}
	if res.Code == patchErrRollback {
		pout("\n⚠ 有文件未能恢复，请用备份手工覆盖：")
		if res.BackupDir != "" {
			pout("  备份目录：%s\n", res.BackupDir)
		}
		for _, p := range res.Unrestored {
			pout("  - %s\n", p)
		}
	}
	if res.Message != "" {
		pout("\n%s\n", res.Message)
	}
}

func statusLabel(s string) string {
	switch s {
	case "ok":
		return "可应用"
	case "conflict":
		return "冲突"
	case "blocked":
		return "不可用"
	case "missing":
		return "文件缺失"
	case "unsupported":
		return "不支持"
	case "applied":
		return "已应用"
	case "skipped":
		return "已跳过"
	case "failed":
		return "失败"
	case "notapplied":
		return "未执行"
	}
	return s
}

// patchHintFor 把失败状态翻成一句可执行建议（UI 与 CLI 共用）。
func patchHintFor(status, reason string) string {
	switch status {
	case "conflict":
		return "打开目标文件核对上下文后重新生成该 hunk；或改用 --partial 跳过它"
	case "blocked":
		if strings.Contains(reason, "生成后被修改") {
			return "重新生成补丁，或先手工合并该文件的改动"
		}
		if strings.Contains(reason, "已存在") {
			return "比较两者内容后决定保留哪个（不会自动覆盖）"
		}
		return "按提示修正路径或权限后重试"
	case "unsupported":
		return "拆成「删除旧文件 + 新建文件」两个纯文本操作"
	case "skipped":
		return "修好该文件后单独重新应用，其余已写入的保持不动"
	}
	return ""
}

func patchErrorText(err error) string {
	if err == nil {
		return ""
	}
	pe := patchErrorOf(err)
	if pe.Detail != "" {
		return fmt.Sprintf("%s：%s\n  %s", pe.Code, pe.Msg, pe.Detail)
	}
	return fmt.Sprintf("%s：%s", pe.Code, pe.Msg)
}

var _ = time.Now
