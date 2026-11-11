package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// AI 配置（profiles / prompts / preferences / 审批白名单）落盘为 appdata 下的 ai-config.json。
// localStorage 继续保留一份镜像，便于旧版本回退；文件存在时以文件为准。
const aiConfigFileMax = 1 << 20

func aiConfigFilePath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "ai-config.json")
}

func readAIConfigFile(path string) (string, error) {
	if path == "" {
		return "", errors.New("无法定位应用数据目录")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if info.Size() > aiConfigFileMax {
		return "", fmt.Errorf("AI 配置超过 %d KB", aiConfigFileMax/1024)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func writeAIConfigFile(path, data string) error {
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	if len(data) > aiConfigFileMax {
		return fmt.Errorf("AI 配置超过 %d KB", aiConfigFileMax/1024)
	}
	return writeFileAtomicMode(path, []byte(data), 0o600)
}

func (a *App) AIConfigRead() (string, error) {
	return readAIConfigFile(aiConfigFilePath())
}

func (a *App) AIConfigWrite(data string) error {
	return writeAIConfigFile(aiConfigFilePath(), data)
}
