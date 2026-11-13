package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type convertJob struct {
	Input  string `json:"input"`
	Output string `json:"output"`
}

type convertOptions struct {
	Jobs   []convertJob
	To     string
	Stdout bool
	Force  bool
}

type convertRequest struct {
	Jobs   []convertJob `json:"jobs"`
	To     string       `json:"to"`
	Stdout bool         `json:"stdout"`
}

type convertResult struct {
	Input   string `json:"input"`
	Output  string `json:"output"`
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

type convertPayload struct {
	Stdout  bool            `json:"stdout"`
	Results []convertResult `json:"results"`
}

var convertTargetExt = map[string]string{
	"json":  ".json",
	"jsonl": ".jsonl",
	"yaml":  ".yaml",
	"xml":   ".xml",
	"csv":   ".csv",
	"toml":  ".toml",
	"ini":   ".ini",
}

func normalizeConvertTarget(value string) (string, string, error) {
	id := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(value, ".")))
	switch id {
	case "yml":
		id = "yaml"
	case "ndjson":
		id = "jsonl"
	}
	ext, ok := convertTargetExt[id]
	if !ok {
		return "", "", fmt.Errorf("不支持的目标格式：%s（可用：json/jsonl/yaml/xml/csv/toml/ini）", value)
	}
	return id, ext, nil
}

func replaceFileExt(path, ext string) string {
	current := filepath.Ext(path)
	return strings.TrimSuffix(path, current) + ext
}

func expandConvertInputs(args []string) ([]string, error) {
	out := make([]string, 0, len(args))
	for _, arg := range args {
		if strings.ContainsAny(arg, "*?[") {
			matches, err := filepath.Glob(arg)
			if err != nil {
				return nil, fmt.Errorf("通配符无效：%s", arg)
			}
			if len(matches) == 0 {
				return nil, fmt.Errorf("没有匹配的文件：%s", arg)
			}
			out = append(out, matches...)
			continue
		}
		info, err := os.Stat(arg)
		if err != nil {
			return nil, fmt.Errorf("无法读取输入：%s", arg)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("输入是目录：%s", arg)
		}
		out = append(out, arg)
	}
	return out, nil
}

func parseConvertArgs(args []string) (*convertOptions, bool, error) {
	isConvert := false
	// 先整体判断是否转换模式：GUI 启动参数（--new-window / --ai-float / --debug-console 等）
	// 不能当成未知参数拒绝，否则独立窗口子进程会在启动前直接退出。
	for _, arg := range args {
		if strings.TrimSpace(arg) == "--convert" {
			isConvert = true
			break
		}
	}
	var inputs []string
	to := ""
	out := ""
	stdout := false
	force := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--convert":
		case arg == "--to" || arg == "-t":
			i++
			if i >= len(args) {
				return nil, true, errors.New("--to 缺少格式名")
			}
			to = args[i]
		case strings.HasPrefix(arg, "--to="):
			to = strings.TrimPrefix(arg, "--to=")
		case arg == "--out" || arg == "-o":
			i++
			if i >= len(args) {
				return nil, true, errors.New("--out 缺少路径")
			}
			out = args[i]
		case strings.HasPrefix(arg, "--out="):
			out = strings.TrimPrefix(arg, "--out=")
		case arg == "--stdout":
			stdout = true
		case arg == "--force":
			force = true
		case arg == "--help" || arg == "-h":
			if isConvert {
				return nil, true, errors.New(convertUsage)
			}
		case strings.HasPrefix(arg, "-"):
			if !isConvert {
				continue
			}
			return nil, true, fmt.Errorf("未知参数：%s", arg)
		default:
			inputs = append(inputs, arg)
		}
	}
	if !isConvert {
		return nil, false, nil
	}
	if to == "" {
		return nil, true, errors.New("缺少 --to 目标格式\n" + convertUsage)
	}
	targetID, targetExt, err := normalizeConvertTarget(to)
	if err != nil {
		return nil, true, err
	}
	if len(inputs) == 0 {
		return nil, true, errors.New("缺少输入文件\n" + convertUsage)
	}
	expanded, err := expandConvertInputs(inputs)
	if err != nil {
		return nil, true, err
	}
	for i, input := range expanded {
		if abs, err := filepath.Abs(input); err == nil {
			expanded[i] = abs
		}
	}
	if stdout && len(expanded) > 1 {
		return nil, true, errors.New("--stdout 只能用于单个输入文件")
	}
	if out != "" {
		if abs, err := filepath.Abs(out); err == nil {
			out = abs
		}
	}
	outIsDir := false
	if out != "" {
		if info, err := os.Stat(out); err == nil && info.IsDir() {
			outIsDir = true
		} else if strings.HasSuffix(out, string(os.PathSeparator)) || strings.HasSuffix(out, "/") {
			return nil, true, fmt.Errorf("输出目录不存在：%s", out)
		}
	}
	if out != "" && !outIsDir && len(expanded) > 1 {
		return nil, true, errors.New("多个输入文件时 --out 必须是已存在的目录")
	}
	jobs := make([]convertJob, 0, len(expanded))
	for _, input := range expanded {
		output := ""
		if !stdout {
			switch {
			case outIsDir:
				output = filepath.Join(out, replaceFileExt(filepath.Base(input), targetExt))
			case out != "":
				output = out
			default:
				output = replaceFileExt(input, targetExt)
			}
			if !force && output != "" {
				if _, err := os.Stat(output); err == nil {
					return nil, true, fmt.Errorf("输出文件已存在：%s（加 --force 覆盖）", output)
				}
			}
		}
		jobs = append(jobs, convertJob{Input: input, Output: output})
	}
	return &convertOptions{Jobs: jobs, To: targetID, Stdout: stdout, Force: force}, true, nil
}

const convertUsage = `用法：
  CaDt-DataLens.exe --convert <输入...> --to <格式> [--out <文件|目录>] [--stdout] [--force]

格式：json、jsonl、yaml、xml、csv、toml、ini
示例：
  CaDt-DataLens.exe --convert a.json --to yaml
  CaDt-DataLens.exe --convert logs\*.jsonl --to csv --out dist\
  CaDt-DataLens.exe --convert config.yaml --to json --stdout`

// GetConvertRequest 供前端在 CLI 转换模式下读取任务；普通窗口返回空串。
func (a *App) GetConvertRequest() string {
	if a.convert == nil {
		return ""
	}
	data, err := json.Marshal(convertRequest{Jobs: a.convert.Jobs, To: a.convert.To, Stdout: a.convert.Stdout})
	if err != nil {
		return ""
	}
	return string(data)
}

// FinishConvert 写回转换结果并退出隐藏窗口。
func (a *App) FinishConvert(payload string) error {
	if a.convert == nil {
		return errors.New("当前不是转换模式")
	}
	var data convertPayload
	if err := json.Unmarshal([]byte(payload), &data); err != nil {
		a.finishConvertWithError(fmt.Errorf("转换结果格式无效：%w", err))
		return err
	}
	var firstErr error
	written := 0
	for _, result := range data.Results {
		if strings.TrimSpace(result.Error) != "" {
			fmt.Fprintf(os.Stderr, "转换失败 %s：%s\n", result.Input, result.Error)
			if firstErr == nil {
				firstErr = errors.New(result.Error)
			}
			continue
		}
		if result.Output == "" {
			fmt.Fprint(os.Stdout, result.Content)
			if !strings.HasSuffix(result.Content, "\n") {
				fmt.Fprintln(os.Stdout)
			}
			continue
		}
		if err := os.WriteFile(result.Output, []byte(result.Content), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "写入失败 %s：%v\n", result.Output, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		written++
		fmt.Fprintf(os.Stderr, "已转换：%s -> %s\n", result.Input, result.Output)
	}
	if firstErr != nil {
		a.convertExitCode = 1
	} else {
		a.convertExitCode = 0
	}
	if data.Stdout {
		fmt.Fprintln(os.Stderr, "完成。")
	} else {
		fmt.Fprintf(os.Stderr, "完成，共写入 %d 个文件。\n", written)
	}
	a.convertDone.Store(true)
	go runtime.Quit(a.ctx)
	return firstErr
}

func (a *App) finishConvertWithError(err error) {
	fmt.Fprintln(os.Stderr, err)
	a.convertExitCode = 1
	a.convertDone.Store(true)
	go runtime.Quit(a.ctx)
}

func (a *App) convertMode() bool { return a.convert != nil }

func (a *App) waitConvertTimeout() {
	go func() {
		<-time.After(30 * time.Second)
		if !a.convertDone.Load() {
			fmt.Fprintln(os.Stderr, "转换超时：前端未返回结果")
			a.convertExitCode = 1
			os.Exit(1)
		}
	}()
}
