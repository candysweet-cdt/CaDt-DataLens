package aiconfig

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"datalens/internal/dpapi"
)

func TestAIConfigFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	got, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("缺失文件应返回空串，得到 %q", got)
	}
	payload := `{"profiles":[{"id":"p1"}],"preferences":[]}`
	if err := WriteFile(path, payload); err != nil {
		t.Fatal(err)
	}
	got, err = ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("read = %q, want %q", got, payload)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("临时文件未清理：%s", entry.Name())
		}
	}
}

func TestAIConfigFileRejectsOversize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	big := strings.Repeat("x", FileMax+1)
	if err := WriteFile(path, big); err == nil {
		t.Fatal("超限写入应报错")
	}
	if err := os.WriteFile(path, []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(path); err == nil {
		t.Fatal("超限读取应报错")
	}
}

func TestAIConfigFileEmptyPath(t *testing.T) {
	if _, err := ReadFile(""); err == nil {
		t.Fatal("空路径应报错")
	}
	if err := WriteFile("", "{}"); err == nil {
		t.Fatal("空路径应报错")
	}
}

func TestAppAIConfigRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := &Store{}
	if got, err := app.AIConfigRead(); err != nil || got != "" {
		t.Fatalf("初始读取 = %q, %v", got, err)
	}
	payload := `{"profiles":[],"autoTitle":false}`
	if err := app.AIConfigWrite(payload); err != nil {
		t.Fatal(err)
	}
	got, err := app.AIConfigRead()
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("读取 = %q, want %q", got, payload)
	}
}

// 有 DPAPI 的平台（Windows）落盘必须是密文：文件名照旧，但内容里不能出现明文密钥。
func TestAIConfigFileEncryptedAtRest(t *testing.T) {
	if !dpapi.Supported() {
		t.Skip("当前平台没有 DPAPI，按设计保持明文")
	}
	path := filepath.Join(t.TempDir(), "ai-config.json")
	payload := `{"profiles":[{"id":"p1","apiKey":"sk-plaintext-must-not-leak"}]}`
	if err := WriteFile(path, payload); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), sealedPrefix) {
		t.Fatalf("落盘内容缺少密文前缀：%q", string(raw))
	}
	if strings.Contains(string(raw), "sk-plaintext-must-not-leak") {
		t.Fatal("密文里出现了明文密钥")
	}
	got, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("解密后 = %q, want %q", got, payload)
	}
}

// 旧版本写下的明文配置要照常能读；下一次保存自动升级成密文。
func TestAIConfigLegacyPlaintextUpgrades(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	legacy := `{"profiles":[],"legacy":true}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFile(path)
	if err != nil || got != legacy {
		t.Fatalf("读旧明文 = %q, %v", got, err)
	}
	if !dpapi.Supported() {
		return
	}
	if err := WriteFile(path, got); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), sealedPrefix) {
		t.Fatal("保存后应升级为密文")
	}
}

// 留档：解不开的密文被改名保留，正常明文文件不动。
func TestAIConfigBackupSealed(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	path := Path()
	if path == "" {
		t.Fatal("测试环境应能定位应用数据目录")
	}
	if !dpapi.Supported() {
		t.Skip("当前平台没有 DPAPI")
	}
	broken := sealedPrefix + "bm90LWRwYXBpLWRhdGE="
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	backup, err := BackupSealed()
	if err != nil || backup == "" {
		t.Fatalf("留档 = %q, %v", backup, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("原文件应已被改名")
	}
	moved, err := os.ReadFile(backup)
	if err != nil || string(moved) != broken {
		t.Fatalf("留档内容 = %q, %v", string(moved), err)
	}
	// 明文文件不该被留档（那是正常配置）。
	if err := os.WriteFile(path, []byte(`{"profiles":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if again, err := BackupSealed(); err != nil || again != "" {
		t.Fatalf("明文文件不应留档：%q, %v", again, err)
	}
}
// 比较-交换：基线一致才写；不一致回传磁盘最新明文且绝不改文件。
func TestWriteIfUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	base := `{"profiles":[],"activeSessionId":"a"}`
	if err := WriteFile(path, base); err != nil {
		t.Fatal(err)
	}
	mine := `{"profiles":[],"activeSessionId":"b"}`
	res, err := WriteIfUnchanged(path, base, mine)
	if err != nil || !res.Written {
		t.Fatalf("基线一致时应写入：%+v, %v", res, err)
	}
	if got, err := ReadFile(path); err != nil || got != mine {
		t.Fatalf("写入后 = %q, %v", got, err)
	}

	// 另一个窗口在这之后写了 theirs：我方基线（mine）已过期。
	theirs := `{"profiles":[],"activeSessionId":"c"}`
	if err := WriteFile(path, theirs); err != nil {
		t.Fatal(err)
	}
	res, err = WriteIfUnchanged(path, mine, `{"profiles":[],"activeSessionId":"d"}`)
	if err != nil {
		t.Fatal(err)
	}
	if res.Written {
		t.Fatal("基线过期时不得写入（否则会回滚另一窗口的修改）")
	}
	if res.Current != theirs {
		t.Fatalf("Current = %q, want %q", res.Current, theirs)
	}
	if got, err := ReadFile(path); err != nil || got != theirs {
		t.Fatalf("冲突时不得改动文件：%q, %v", got, err)
	}
}

// 空基线（文件不存在 = 首次写）照常写入。
func TestWriteIfUnchangedEmptyBase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	res, err := WriteIfUnchanged(path, "", `{"profiles":[]}`)
	if err != nil || !res.Written {
		t.Fatalf("空基线应写入：%+v, %v", res, err)
	}
	if got, err := ReadFile(path); err != nil || got != `{"profiles":[]}` {
		t.Fatalf("read = %q, %v", got, err)
	}
}

// 解不开的密文不能被当成「空配置」覆盖：必须报 ErrSealed 让调用方先留档。
func TestWriteIfUnchangedSealed(t *testing.T) {
	if !dpapi.Supported() {
		t.Skip("当前平台没有 DPAPI")
	}
	path := filepath.Join(t.TempDir(), "ai-config.json")
	broken := sealedPrefix + "bm90LWRwYXBpLWRhdGE="
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteIfUnchanged(path, "", `{"profiles":[]}`); !errors.Is(err, ErrSealed) {
		t.Fatalf("err = %v, want ErrSealed", err)
	}
	if raw, err := os.ReadFile(path); err != nil || string(raw) != broken {
		t.Fatalf("失败路径不得改动文件：%q, %v", string(raw), err)
	}
}

func TestAIConfigSealedUnreadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ai-config.json")
	if !dpapi.Supported() {
		t.Skip("当前平台没有 DPAPI")
	}
	// 伪造一份「别人机器上的密文」：合法前缀 + 无法解密的 base64。
	broken := sealedPrefix + "bm90LWRwYXBpLWRhdGE="
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(path); !errors.Is(err, ErrSealed) {
		t.Fatalf("err = %v, want ErrSealed", err)
	}
	if !strings.Contains(ErrSealed.Error(), SealedErrorToken) {
		t.Fatal("ErrSealed 文案必须带稳定标记，前端靠它判断是否禁用保存")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != broken {
		t.Fatalf("读失败不应改动原文件：%q, %v", string(raw), err)
	}
}
