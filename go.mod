module github.com/soksak/soksak-core

go 1.25.0

require (
	github.com/fsnotify/fsnotify v1.10.1
	github.com/soksak/soksak-contract-control v0.0.1
	github.com/soksak/soksak-plugin-terminal-xterm v0.0.1
	github.com/soksak/wails-service-native-compositor v0.0.1
	github.com/soksak/wails-service-webview-surface v0.0.1
	github.com/wailsapp/wails/v3 v3.0.0-dev
	modernc.org/sqlite v1.56.0
)

require (
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/coder/websocket v1.8.14 // indirect
	github.com/creack/pty v1.1.24 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jchv/go-winloader v0.0.0-20250406163304-c1995be93bd1 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/soksak/soksak-contract-terminal v0.0.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	modernc.org/libc v1.74.4 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)

replace github.com/wailsapp/wails/v3 => ../frameworks/wails3/v3

replace github.com/soksak/wails-service-native-compositor => ../wails-services/wails-service-native-compositor

replace github.com/soksak/wails-service-webview-surface => ../wails-services/wails-service-webview-surface

replace github.com/soksak/soksak-plugin-terminal-xterm => ../soksak-plugins/soksak-plugin-terminal-xterm

replace github.com/soksak/soksak-contract-control => ../soksak-contracts/soksak-contract-control

replace github.com/soksak/soksak-contract-terminal => ../soksak-contracts/soksak-contract-terminal
