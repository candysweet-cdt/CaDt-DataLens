package main

import (
	"embed"
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

	ensureAppDataDir()
	startAppLog()
	defer stopAppLog()
	writeAppLog("info", "启动 CaDt-DataLens %s", appVersion)
	if exe, err := os.Executable(); err == nil {
		writeAppLog("info", "程序路径：%s", exe)
	}
	writeAppLog("info", "启动参数：%q", os.Args[1:])

	app := NewApp()

	width, height, minWidth, minHeight := 1280, 800, 720, 480
	if hasArg("--ai-float") {
		width, height, minWidth, minHeight = 560, 760, 360, 480
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
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               uniqueIDForLaunch(),
			OnSecondInstanceLaunch: app.secondInstance,
		},
		Bind: []interface{}{app},
	})
	if err != nil {
		writeAppLog("error", "wails.Run 退出：%v", err)
	}
}
