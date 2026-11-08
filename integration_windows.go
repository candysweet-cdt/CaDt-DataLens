//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	assocProgID    = "CaDt-DataLens.file"
	assocLabel     = "数据文件 (CaDt-DataLens)"
	shellKeyName   = "CaDt-DataLens"
	classesRoot    = `Software\Classes\`
	shellChgAssoc  = 0x08000000
	shellChgIdList = 0x0000
)

var assocExtensions = []string{
	"json", "jsonc", "json5", "jsonl", "ndjson",
	"yaml", "yml",
	"xml", "svg",
	"csv", "tsv",
	"txt", "md", "log", "ini", "toml", "properties", "conf", "cfg",
}

type IntegrationStatus struct {
	Executable  string `json:"executable"`
	FileAssoc   bool   `json:"fileAssoc"`
	ContextMenu bool   `json:"contextMenu"`
}

var shChangeNotify = windows.NewLazySystemDLL("shell32.dll").NewProc("SHChangeNotify")
var regSetValueEx = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegSetValueExW")

func notifyShell() {
	shChangeNotify.Call(shellChgAssoc, shellChgIdList, 0, 0)
}

func setNoneValue(key registry.Key, name string) error {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	ret, _, callErr := regSetValueEx.Call(uintptr(key), uintptr(unsafe.Pointer(namePtr)), 0, uintptr(registry.NONE), 0, 0)
	if ret != 0 {
		if callErr != windows.ERROR_SUCCESS {
			return callErr
		}
		return syscall.Errno(ret)
	}
	return nil
}

func commandFor(exe, arg string) string {
	return fmt.Sprintf("\"%s\" \"%s\"", exe, arg)
}

func commandMatches(cmd, exe string) bool {
	if cmd == "" || exe == "" {
		return false
	}
	c := strings.ToLower(strings.ReplaceAll(cmd, `\`, `/`))
	e := strings.ToLower(strings.ReplaceAll(exe, `\`, `/`))
	return strings.Contains(c, e)
}

func readDefault(path string) string {
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, _, err := key.GetStringValue("")
	if err != nil {
		return ""
	}
	return value
}

func setString(path, name, value string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue(name, value)
}

func deleteKeyTree(path string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
	if err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return nil
		}
		return err
	}
	names, err := key.ReadSubKeyNames(-1)
	key.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := deleteKeyTree(path + `\` + name); err != nil {
			return err
		}
	}
	err = registry.DeleteKey(registry.CURRENT_USER, path)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return nil
	}
	return err
}

func registerFileAssociation(exe string) error {
	prog := classesRoot + assocProgID
	if err := setString(prog, "", assocLabel); err != nil {
		return err
	}
	if err := setString(prog+`\DefaultIcon`, "", fmt.Sprintf("\"%s\",0", exe)); err != nil {
		return err
	}
	if err := setString(prog+`\shell\open\command`, "", commandFor(exe, "%1")); err != nil {
		return err
	}
	for _, ext := range assocExtensions {
		path := classesRoot + "." + ext + `\OpenWithProgids`
		key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
		if err != nil {
			return err
		}
		err = setNoneValue(key, assocProgID)
		key.Close()
		if err != nil {
			return err
		}
	}
	appKey := classesRoot + `Applications\` + filepath.Base(exe)
	if err := setString(appKey, "FriendlyAppName", "CaDt-DataLens"); err != nil {
		return err
	}
	return setString(appKey+`\shell\open\command`, "", commandFor(exe, "%1"))
}

func unregisterFileAssociation(exe string) error {
	if err := deleteKeyTree(classesRoot + assocProgID); err != nil {
		return err
	}
	for _, ext := range assocExtensions {
		path := classesRoot + "." + ext + `\OpenWithProgids`
		key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ALL_ACCESS)
		if err != nil {
			if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
				continue
			}
			return err
		}
		err = key.DeleteValue(assocProgID)
		key.Close()
		if err != nil && !errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return err
		}
	}
	if exe != "" {
		_ = deleteKeyTree(classesRoot + `Applications\` + filepath.Base(exe))
	}
	_ = deleteKeyTree(classesRoot + `Applications\CaDt-DataLens.exe`)
	return nil
}

func contextMenuEntries() []struct {
	path  string
	label string
	arg   string
} {
	return []struct {
		path  string
		label string
		arg   string
	}{
		{classesRoot + `*\shell\` + shellKeyName, "用 CaDt-DataLens 打开", "%1"},
		{classesRoot + `Directory\shell\` + shellKeyName, "用 CaDt-DataLens 打开文件夹", "%1"},
		{classesRoot + `Directory\Background\shell\` + shellKeyName, "在 CaDt-DataLens 中打开", "%V"},
	}
}

func registerContextMenu(exe string) error {
	for _, entry := range contextMenuEntries() {
		if err := setString(entry.path, "", entry.label); err != nil {
			return err
		}
		if err := setString(entry.path, "Icon", fmt.Sprintf("\"%s\",0", exe)); err != nil {
			return err
		}
		if err := setString(entry.path+`\command`, "", commandFor(exe, entry.arg)); err != nil {
			return err
		}
	}
	return nil
}

func unregisterContextMenu() error {
	for _, entry := range contextMenuEntries() {
		if err := deleteKeyTree(entry.path); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) SetFileAssociation(enabled bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if enabled {
		err = registerFileAssociation(exe)
	} else {
		err = unregisterFileAssociation(exe)
	}
	if err != nil {
		return err
	}
	notifyShell()
	return nil
}

func (a *App) SetContextMenu(enabled bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if enabled {
		err = registerContextMenu(exe)
	} else {
		err = unregisterContextMenu()
	}
	if err != nil {
		return err
	}
	notifyShell()
	return nil
}

func (a *App) GetIntegrationStatus() (*IntegrationStatus, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	status := &IntegrationStatus{
		Executable: exe,
		FileAssoc:  commandMatches(readDefault(classesRoot+assocProgID+`\shell\open\command`), exe),
	}
	status.ContextMenu = true
	for _, entry := range contextMenuEntries() {
		if !commandMatches(readDefault(entry.path+`\command`), exe) {
			status.ContextMenu = false
			break
		}
	}
	return status, nil
}
