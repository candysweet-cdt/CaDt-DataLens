package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSafeRunFileName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"main.py", "main.py"},
		{`D:\data\a.py`, "a.py"},
		{"../../evil.py", "evil.py"},
		{`a<b>c|d?.py`, "a_b_c_d_.py"},
		{"  spaced name.js  ", "spaced name.js"},
		{"", ""},
		{"..", ""},
		{"   ", ""},
		{"trailing. ", "trailing"},
		{"中文脚本.py", "中文脚本.py"},
	}
	for _, c := range cases {
		if got := safeRunFileName(c.in); got != c.want {
			t.Errorf("safeRunFileName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDecodeRunOutput(t *testing.T) {
	gbk := []byte{0xD6, 0xD0, 0xCE, 0xC4} // “中文”的 GBK 字节
	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"ascii", []byte("hello"), "hello"},
		{"utf8", []byte("你好"), "你好"},
		{"gbk", gbk, "中文"},
		{"empty", nil, ""},
	}
	for _, c := range cases {
		if got := decodeRunOutput(c.in); got != c.want {
			t.Errorf("%s: decodeRunOutput = %q, want %q", c.name, got, c.want)
		}
	}
	// 完全无效的字节不 panic，且保持可显示
	if got := decodeRunOutput([]byte{0xFF, 0xFE, 0xFD}); got == "" {
		t.Errorf("无效字节应返回替换串而不是空串")
	}
}

func TestEnvWithPathPrepend(t *testing.T) {
	t.Setenv("CA_DT_RUN_PATH_TEST", "keep")
	env := envWithPathPrepend(`C:\msys64\mingw64\bin`)

	var paths []string
	for _, kv := range env {
		if len(kv) > 5 && strings.EqualFold(kv[:5], "PATH=") {
			paths = append(paths, kv[5:])
		}
	}
	if len(paths) != 1 {
		t.Fatalf("PATH 条目数 = %d，期望 1（不允许出现重复 PATH）", len(paths))
	}
	if !strings.HasPrefix(paths[0], `C:\msys64\mingw64\bin`) {
		t.Fatalf("PATH 未前置：%q", paths[0])
	}
	if len(paths[0]) <= len(`C:\msys64\mingw64\bin`) {
		t.Fatalf("前置 PATH 后丢失了原 PATH：%q", paths[0])
	}
}

func TestEnvWithPathPrependEmptyKeepsEnv(t *testing.T) {
	before := len(envWithPathPrepend(""))
	if after := len(envWithPathPrepend("   ")); after != before {
		t.Fatalf("空前置不应改变环境：%d vs %d", before, after)
	}
}

func TestPrepareRunDiskSource(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "main.py")
	if err := os.WriteFile(src, []byte("print(1)\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	ws, err := app.PrepareRun(RunSpec{SrcPath: src})
	if err != nil {
		t.Fatalf("PrepareRun 失败：%v", err)
	}
	if ws.SourcePath != src {
		t.Errorf("SourcePath = %q, want %q", ws.SourcePath, src)
	}
	if ws.WorkDir != dir {
		t.Errorf("WorkDir = %q, want %q（应优先源文件所在目录）", ws.WorkDir, dir)
	}
	if ws.TempDir != "" || ws.TempCopy {
		t.Errorf("无修改时不应创建临时副本：%+v", ws)
	}
}

func TestPrepareRunTempCopy(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "main.py")
	if err := os.WriteFile(src, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	ws, err := app.PrepareRun(RunSpec{SrcPath: src, Content: "print('new')\n", TempName: "main.py"})
	if err != nil {
		t.Fatalf("PrepareRun 失败：%v", err)
	}
	defer func() { _ = app.CleanupRunTemp(ws.TempDir) }()
	if !ws.TempCopy {
		t.Error("应标记为临时副本")
	}
	if ws.TempDir == "" || !strings.HasPrefix(ws.SourcePath, ws.TempDir) {
		t.Fatalf("临时副本路径不在临时目录内：%+v", ws)
	}
	if ws.WorkDir != dir {
		t.Errorf("WorkDir = %q，临时副本仍应在原文件目录下运行", ws.WorkDir)
	}
	body, err := os.ReadFile(ws.SourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "print('new')\n" {
		t.Errorf("临时副本内容 = %q", string(body))
	}
	if disk, _ := os.ReadFile(src); string(disk) != "old\n" {
		t.Error("原文件不应被改动")
	}
}

func TestPrepareRunNeedTempForBuild(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "main.c")
	if err := os.WriteFile(src, []byte("int main(){return 0;}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	ws, err := app.PrepareRun(RunSpec{SrcPath: src, NeedTemp: true})
	if err != nil {
		t.Fatalf("PrepareRun 失败：%v", err)
	}
	defer func() { _ = app.CleanupRunTemp(ws.TempDir) }()
	if ws.TempDir == "" {
		t.Fatal("编译型语言应拿到临时目录")
	}
	if ws.TempCopy {
		t.Error("需求临时目录不等于临时副本")
	}
	if st, err := os.Stat(ws.TempDir); err != nil || !st.IsDir() {
		t.Fatalf("临时目录不存在：%v", err)
	}
}

func TestPrepareRunErrors(t *testing.T) {
	app := &App{}
	if _, err := app.PrepareRun(RunSpec{}); err == nil {
		t.Error("空请求应报错")
	}
	if _, err := app.PrepareRun(RunSpec{SrcPath: filepath.Join(t.TempDir(), "nope.py")}); err == nil {
		t.Error("不存在的源文件应报错")
	}
	if _, err := app.PrepareRun(RunSpec{Content: "x", TempName: ".."}); err == nil {
		t.Error("非法临时文件名应报错")
	}
}

func TestCleanupRunTempGuards(t *testing.T) {
	app := &App{}
	if err := app.CleanupRunTemp(""); err != nil {
		t.Errorf("空目录应静默成功：%v", err)
	}
	outside := t.TempDir()
	if err := app.CleanupRunTemp(outside); err == nil {
		t.Error("应拒绝删除非运行临时目录")
	}
	dir, err := newRunTempDir()
	if err != nil {
		t.Fatalf("创建临时目录失败：%v", err)
	}
	if err := app.CleanupRunTemp(dir); err != nil {
		t.Fatalf("清理临时目录失败：%v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("临时目录应已被删除")
	}
}

func TestCleanupRunTempStale(t *testing.T) {
	fresh, err := newRunTempDir()
	if err != nil {
		t.Fatalf("创建临时目录失败：%v", err)
	}
	defer func() { _ = os.RemoveAll(fresh) }()
	stale, err := newRunTempDir()
	if err != nil {
		t.Fatalf("创建临时目录失败：%v", err)
	}
	old := time.Now().Add(-runTempKeep - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatalf("改时间戳失败：%v", err)
	}
	app := &App{}
	if _, err := app.CleanupRunTempStale(); err != nil {
		t.Fatalf("清理过期目录失败：%v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("过期临时目录应被清理")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("未过期临时目录不应被清理")
	}
}

func TestRunExecValidation(t *testing.T) {
	app := &App{}
	if err := app.RunExec("", "cmd.exe", nil, "", ""); err == nil {
		t.Error("空 id 应报错")
	}
	if err := app.RunExec("run-x", "", nil, "", ""); err == nil {
		t.Error("空 exe 应报错")
	}
	if err := app.RunExec("run-x", "cmd.exe", nil, filepath.Join(t.TempDir(), "missing"), ""); err == nil {
		t.Error("不存在的工作目录应报错")
	}
	if err := app.RunStop(""); err == nil {
		t.Error("空 id 停止应报错")
	}
	if err := app.RunStop("run-not-exists"); err != nil {
		t.Errorf("不存在的任务停止应静默：%v", err)
	}
}

// runEvents 收集 runEmitHook 事件，测试用。
type runEvents struct {
	mu     sync.Mutex
	lines  []string
	stream []string
	exit   *RunExit
}

func captureRunEvents(t *testing.T) *runEvents {
	t.Helper()
	events := &runEvents{}
	runEmitHook = func(event string, payload interface{}) {
		events.mu.Lock()
		defer events.mu.Unlock()
		switch event {
		case "run-out":
			data := payload.(map[string]string)
			for _, line := range strings.Split(data["data"], "\n") {
				if line == "" {
					continue
				}
				events.lines = append(events.lines, line)
				events.stream = append(events.stream, data["stream"])
			}
		case "run-exit":
			exit := payload.(RunExit)
			events.exit = &exit
		}
	}
	t.Cleanup(func() { runEmitHook = nil })
	return events
}

func TestRunStreamSplitsDecodesAndFlagsStderr(t *testing.T) {
	events := captureRunEvents(t)
	stream := &runStream{a: &App{}, id: "run-1"}
	// UTF-8 行 + GBK 行（“中文”）+ CRLF
	payload := append([]byte("hello\r\n"), []byte{0xD6, 0xD0, 0xCE, 0xC4, '\n'}...)
	stream.readPipe(bytes.NewReader(payload), "out")
	stream.readPipe(bytes.NewReader([]byte("boom\n")), "err")
	stream.finish()

	if len(events.lines) != 3 {
		t.Fatalf("行数 = %d，期望 3：%#v", len(events.lines), events.lines)
	}
	if events.lines[0] != "hello" || events.lines[1] != "中文" || events.lines[2] != "boom" {
		t.Fatalf("输出解析错误：%#v", events.lines)
	}
	if events.stream[2] != "err" {
		t.Errorf("stderr 未标记：%#v", events.stream)
	}
}

func TestRunStreamTruncatesOverLimit(t *testing.T) {
	events := captureRunEvents(t)
	stream := &runStream{a: &App{}, id: "run-2"}
	big := strings.Repeat("x", 1024)
	for i := 0; i < int(runOutputCap/1024)+8; i++ {
		stream.add("out", big)
	}
	stream.finish()
	joined := strings.Join(events.lines, "\n")
	if !strings.Contains(joined, "已截断") {
		t.Fatal("超出上限应给出截断提示")
	}
	if int64(len(joined)) > runOutputCap*2 {
		t.Fatalf("截断后仍然过大：%d 字节", len(joined))
	}
}

func TestRunExecEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("cmd.exe"); err != nil {
		t.Skip("缺少 cmd.exe")
	}
	events := captureRunEvents(t)
	app := &App{}
	if err := app.RunExec("run-e2e", "cmd.exe", []string{"/c", "echo hi & exit 3"}, "", ""); err != nil {
		t.Fatalf("RunExec 失败：%v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		events.mu.Lock()
		done := events.exit != nil
		events.mu.Unlock()
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	events.mu.Lock()
	defer events.mu.Unlock()
	if events.exit == nil {
		t.Fatal("超时：没有收到 run-exit")
	}
	if events.exit.Code != 3 {
		t.Errorf("退出码 = %d，期望 3", events.exit.Code)
	}
	found := false
	for _, line := range events.lines {
		if strings.Contains(line, "hi") {
			found = true
		}
	}
	if !found {
		t.Errorf("没有收到标准输出：%#v", events.lines)
	}
}

func TestRunInputValidation(t *testing.T) {
	app := &App{}
	if err := app.RunInput("missing", "x"); err == nil {
		t.Error("不存在的运行 id 应报错")
	}
	if err := app.RunEndInput("missing"); err == nil {
		t.Error("不存在的运行 id 应报错")
	}

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	id := "run-input-validation"
	registerRunStdin(id, w)
	defer unregisterRunStdin(id)

	if err := app.RunInput(id, strings.Repeat("x", runInputMax+1)); err == nil {
		t.Error("超长输入应被拒绝")
	}
	if err := app.RunInput(id, "hello"); err != nil {
		t.Errorf("正常输入不应报错：%v", err)
	}
	// 没人读管道 → pump 写满管道缓冲后会阻塞在 Write，输入只能堆在队列里。
	// 用写满上限的输入快速填死管道（Windows 默认 4 KB、Linux 64 KB），
	// 不再依赖「pump 还没被调度所以队列先满」这种时序运气。
	maxLine := strings.Repeat("x", runInputMax)
	var fullErr error
	for i := 0; i < 200; i++ {
		if err := app.RunInput(id, maxLine); err != nil {
			fullErr = err
			break
		}
	}
	if fullErr == nil {
		t.Fatal("输入队列满应返回错误，不能阻塞 UI")
	}
	if !strings.Contains(fullErr.Error(), "队列已满") {
		t.Fatalf("队列满时错误应说明队列已满，实际：%v", fullErr)
	}
	if err := app.RunEndInput(id); err != nil {
		t.Errorf("关闭输入端失败：%v", err)
	}
	if err := app.RunInput(id, "after-eof"); err == nil {
		t.Error("输入端关闭后不应再接受输入")
	}
}

func TestRunInputEndToEnd(t *testing.T) {
	// 辅助进程模式：用测试二进制自己当子进程，读到 stdin EOF 后把内容原样吐回。
	// 比依赖 cmd.exe / findstr 可靠，也不受沙箱与外部工具影响。
	if os.Getenv("CADT_RUN_STDIN_HELPER") == "1" {
		data, _ := io.ReadAll(os.Stdin)
		fmt.Printf("got:%s", data)
		os.Exit(0)
	}
	t.Setenv("CADT_RUN_STDIN_HELPER", "1")
	events := captureRunEvents(t)
	app := &App{}
	id := "run-stdin-e2e"
	if err := app.RunExec(id, os.Args[0], []string{"-test.run=TestRunInputEndToEnd"}, "", ""); err != nil {
		t.Fatalf("RunExec 失败：%v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		runStdinMu.Lock()
		_, ok := runStdins[id]
		runStdinMu.Unlock()
		if ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("超时：stdin 未注册")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := app.RunInput(id, "hello-stdin"); err != nil {
		t.Fatalf("RunInput 失败：%v", err)
	}
	if err := app.RunEndInput(id); err != nil {
		t.Fatalf("RunEndInput 失败：%v", err)
	}

	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		events.mu.Lock()
		done := events.exit != nil
		events.mu.Unlock()
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	events.mu.Lock()
	defer events.mu.Unlock()
	if events.exit == nil {
		t.Fatal("超时：没有收到 run-exit（关闭 stdin 后进程应结束）")
	}
	if !strings.Contains(strings.Join(events.lines, "\n"), "got:hello-stdin") {
		t.Errorf("子进程没有读到 stdin 输入：%#v", events.lines)
	}
}
