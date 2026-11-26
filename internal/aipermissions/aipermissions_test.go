package aipermissions

// aipermissions_test.go：规则写通道的校验面与并发面。
//
// 守两件事：① 坏 JSON / 非对象一律拒绝，且**不动**既有文件（半截规则会让下次读取整段走默认值）；
// ② 并发整份写不出现半截文件。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPathValidation(t *testing.T) {
	if _, err := Path(""); err == nil {
		t.Fatal("空 root 应报错")
	}
	if _, err := Path(".cadt"); err == nil {
		t.Fatal("相对 root 应报错")
	}
	root := t.TempDir()
	got, err := Path(root)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, DirName, FileName); got != want {
		t.Fatalf("路径 = %q，want %q", got, want)
	}
}

func TestWriteRejectsBadJSON(t *testing.T) {
	root := t.TempDir()
	// 先放一份好文件，确认被拒绝的写入不动它
	if _, err := Write(root, `{"version":1}`); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, DirName, FileName)
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}

	bad := []string{"", "   ", "{", `{"a":}`, "[1,2]", `"str"`, "null", "123"}
	for _, text := range bad {
		if _, err := Write(root, text); err == nil {
			t.Fatalf("坏 JSON %q 应被拒绝", text)
		}
	}
	after, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("被拒绝的写不该改动既有文件：%q → %q", string(before), string(after))
	}
}

func TestWriteRoundTrip(t *testing.T) {
	root := t.TempDir()
	text := "{\n  \"version\": 1,\n  \"rules\": [{\"tool\": \"run_command\", \"action\": \"ask\"}]\n}"
	path, err := Write(root, text)
	if err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	if want := filepath.Join(root, DirName, FileName); path != want {
		t.Fatalf("返回路径 = %q，want %q", path, want)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// 原文入库：不重排、不压缩（用户手改的格式不该被悄悄改掉）
	if string(raw) != text {
		t.Fatalf("读回内容不符：%q", string(raw))
	}
	if !json.Valid(raw) {
		t.Fatal("落盘内容不是合法 JSON")
	}
}

// 读-改-写并发：两次整份写都成功，最终文件是完整的一份（且仍是合法 JSON）。
func TestWriteConcurrentNoTornFile(t *testing.T) {
	root := t.TempDir()
	first := `{"version":1,"rules":[` + strings.Repeat(`{"tool":"a","action":"ask"},`, 200) + `{"tool":"end","action":"ask"}]}`
	second := `{"version":1,"rules":[` + strings.Repeat(`{"tool":"b","action":"allow"},`, 200) + `{"tool":"end","action":"allow"}]}`
	if !json.Valid([]byte(first)) || !json.Valid([]byte(second)) {
		t.Fatal("用例本身的 JSON 不合法")
	}

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, text := range []string{first, second} {
		wg.Add(1)
		go func(idx int, payload string) {
			defer wg.Done()
			_, errs[idx] = Write(root, payload)
		}(i, text)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 次并发写入失败：%v", i, err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(root, DirName, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); got != first && got != second {
		t.Fatalf("并发写后文件既不是 A 也不是 B（长度 %d，可能是半截）", len(got))
	}
	if !json.Valid(raw) {
		t.Fatal("并发写后文件不是合法 JSON")
	}
	// 不留临时文件
	entries, err := os.ReadDir(filepath.Join(root, DirName))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("残留临时文件：%s", entry.Name())
		}
	}
}
