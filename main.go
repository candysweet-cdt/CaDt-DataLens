package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	ensureAppDataDir()

	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "CaDt-DataLens",
		Width:            1280,
		Height:           800,
		MinWidth:         720,
		MinHeight:        480,
		Frameless:        true,
		BackgroundColour: &options.RGBA{R: 30, G: 31, B: 36, A: 1},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
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
		println("Error:", err.Error())
	}
}
