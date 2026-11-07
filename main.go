package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "JsonLens",
		Width:            1280,
		Height:           800,
		MinWidth:         720,
		MinHeight:        480,
		Frameless:        true,
		BackgroundColour: &options.RGBA{R: 30, G: 31, B: 36, A: 1},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true,
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "jsonlens-7f3a9c21",
			OnSecondInstanceLaunch: app.secondInstance,
		},
		Bind: []interface{}{app},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}