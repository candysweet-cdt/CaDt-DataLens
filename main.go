package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	if runInstallerCommand(os.Args[1:]) {
		return
	}
	convertOpts, isConvert, convertErr := parseConvertArgs(os.Args[1:])
	if isConvert {
		attachParentConsole()
		if convertErr != nil {
			fmt.Fprintln(os.Stderr, convertErr)
			os.Exit(2)
		}
	}

	// 补丁命令行：不启动窗口、不依赖 AI，处理完直接退出。
	if patchOpts, isPatch, patchErr := parsePatchArgs(os.Args[1:]); isPatch {
		attachParentConsole()
		if patchErr != nil {
			fmt.Fprintln(os.Stderr, patchErr)
			os.Exit(2)
		}
		os.Exit(runPatchCommand(patchOpts))
	}

	ensureAppDataDir()
	startAppLog()
	defer stopAppLog()
	writeAppLog("info", "启动 CaDt-DataLens %s", appVersion)
	if exe, err := os.Executable(); err == nil {
		writeAppLog("info", "程序路径：%s", exe)
	}
	writeAppLog("info", "启动参数：%q", os.Args[1:])

	app := NewApp()
	app.convert = convertOpts

	width, height, minWidth, minHeight := 1280, 800, 720, 480
	if hasArg("--ai-float") {
		width, height, minWidth, minHeight = 560, 760, 360, 480
	}
	var instanceLock *options.SingleInstanceLock
	if !isConvert {
		instanceLock = &options.SingleInstanceLock{
			UniqueId:               uniqueIDForLaunch(),
			OnSecondInstanceLaunch: app.secondInstance,
		}
	}

	err := wails.Run(&options.App{
		Title:            "CaDt-DataLens",
		Width:            width,
		Height:           height,
		MinWidth:         minWidth,
		MinHeight:        minHeight,
		Frameless:        true,
		StartHidden:      true,
		BackgroundColour: &options.RGBA{R: 30, G: 31, B: 36, A: 1},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: previewAssetMiddleware,
		},
		OnStartup:     app.startup,
		OnDomReady:    app.domReady,
		OnBeforeClose: app.beforeClose,
		Logger:        appLogger{},
		Windows: &windows.Options{
			IsZoomControlEnabled: false,
			DisablePinchZoom:     true,
			ZoomFactor:           1.0,
			WebviewUserDataPath:  webviewDataPath(),
		},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: false,
		},
		SingleInstanceLock: instanceLock,
		Bind:               []interface{}{app},
	})
	if err != nil {
		writeAppLog("error", "wails.Run 退出：%v", err)
	}
	if isConvert {
		os.Exit(app.convertExitCode)
	}
}
