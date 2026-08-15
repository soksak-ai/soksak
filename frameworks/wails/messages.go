package wails

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this framework answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.renderer.needsWindow": {
			EN: `{command} needs a window: name one of {windows}, or call from a window`,
			KO: `{command} 은(는) 창이 필요합니다 — {windows} 중 하나를 지정하거나 창 안에서 호출하십시오`,
		},
		"wails.renderer.windowGone": {
			EN: `window {window} no longer answers {command}`,
			KO: `창 {window} 은(는) 더 이상 {command} 에 응답하지 않습니다`,
		},
		"wails.renderer.notServed": {
			EN: `window {window} does not serve {command}`,
			KO: `창 {window} 은(는) {command} 을(를) 제공하지 않습니다`,
		},
		"wails.renderer.timedOut": {
			EN: `window {window} did not answer {command} within {deadline}`,
			KO: `창 {window} 이(가) {deadline} 안에 {command} 에 응답하지 않았습니다`,
		},
		"wails.renderer.noSuchRequest": {
			EN: `no request {id} is waiting for an answer`,
			KO: `응답을 기다리는 요청 {id} 이(가) 없습니다`,
		},
		"wails.renderer.noVerdict": {
			EN: `window {window} answered {command} without saying whether it succeeded`,
			KO: `창 {window} 이(가) 성공 여부 없이 {command} 에 응답했습니다`,
		},
		"wails.renderer.refused": {
			EN: `window {window} refused {command} — {code}: {message}`,
			KO: `창 {window} 이(가) {command} 을(를) 거부했습니다 — {code}: {message}`,
		},
	})
}

// The refusals the non-darwin window layer answers with. The platform is named
// rather than reporting success, so a caller does not wait for a result that
// never arrives.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.window.revealWithoutKeyUnsupported": {
			EN: "bringing a window forward without taking the keyboard is not implemented on this platform",
			KO: "이 플랫폼에는 키보드를 가져가지 않고 창을 앞으로 올리는 방법이 구현되어 있지 않습니다",
		},
		"wails.window.activationUnsupported": {
			EN: "application activation is not implemented on this platform",
			KO: "이 플랫폼에는 애플리케이션 활성화가 구현되어 있지 않습니다",
		},
		"wails.window.titleUnsupported": {
			EN: "reading a window title is not implemented on this platform",
			KO: "이 플랫폼에는 창 제목 읽기가 구현되어 있지 않습니다",
		},
		"wails.window.contentSizeUnsupported": {
			EN: "reading a window's content size is not implemented on this platform",
			KO: "이 플랫폼에는 창 콘텐츠 크기 읽기가 구현되어 있지 않습니다",
		},
		"wails.window.webviewFrameUnsupported": {
			EN: "reading the web view's frame is not implemented on this platform",
			KO: "이 플랫폼에는 웹 뷰 프레임 읽기가 구현되어 있지 않습니다",
		},
		"wails.window.fitUnsupported": {
			EN: "fitting the web view to its window is not implemented on this platform",
			KO: "이 플랫폼에는 웹 뷰를 창에 맞추는 기능이 구현되어 있지 않습니다",
		},
	})
}

// The refusals the darwin window layer answers with. A window with no native
// lifetime is named as such, so a caller does not read the absence as a size,
// a title, or a completed reveal.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.window.noNativeLifetimeFront": {
			EN: "a window with no native lifetime cannot be ordered to the front",
			KO: "네이티브 수명이 없는 창은 앞으로 올릴 수 없습니다",
		},
		"wails.app.noActivationRequest": {
			EN: "this macOS has no supported application activation request",
			KO: "이 macOS 에는 지원되는 애플리케이션 활성화 요청이 없습니다",
		},
		"wails.window.noNativeLifetimeTitle": {
			EN: "a window with no native lifetime has no title",
			KO: "네이티브 수명이 없는 창에는 제목이 없습니다",
		},
		"wails.window.noTitle": {
			EN: "the window has no title",
			KO: "이 창에는 제목이 없습니다",
		},
		"wails.window.noNativeLifetimeContent": {
			EN: "a window with no native lifetime has no content area",
			KO: "네이티브 수명이 없는 창에는 콘텐츠 영역이 없습니다",
		},
		"wails.window.noNativeLifetimeView": {
			EN: "a window with no native lifetime holds no view",
			KO: "네이티브 수명이 없는 창에는 뷰가 없습니다",
		},
		"wails.window.noWebView": {
			EN: "this window holds no web view",
			KO: "이 창에는 웹 뷰가 없습니다",
		},
		"wails.window.noNativeLifetimeViewToFit": {
			EN: "a window with no native lifetime holds no view to fit",
			KO: "네이티브 수명이 없는 창에는 맞출 뷰가 없습니다",
		},
	})
}

// The refusals the window commands answer a caller with. A caller reads these
// over the command registry, so they are declared here rather than formatted at
// the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.windowPlace.badFrame": {
			EN: "window {window}: {x},{y} {w}x{h} is not a frame a window can occupy",
			KO: "창 {window}: {x},{y} {w}x{h} 는 창이 차지할 수 있는 프레임이 아닙니다",
		},
		"wails.windowMonitors.noDisplays": {
			EN: "the screen catalogue is empty; the displays have not been enumerated",
			KO: "화면 목록이 비어 있습니다 — 디스플레이가 열거되지 않았습니다",
		},
		"wails.windowCreate.badFrame": {
			EN: "window_create: {rect} is not a frame a window can occupy",
			KO: "window_create: {rect} 는 창이 차지할 수 있는 프레임이 아닙니다",
		},
		"wails.windowCreate.noAddress": {
			EN: "window {window} never became an address",
			KO: "창 {window} 이(가) 주소가 되지 못했습니다",
		},
		"wails.windowCreate.nameNotAddressable": {
			EN: `window name "{name}" is not addressable; it must be "{control}" or {prefix}<id>`,
			KO: `창 이름 "{name}" 은(는) 주소로 쓸 수 없습니다 — "{control}" 또는 {prefix}<id> 여야 합니다`,
		},
		"wails.windowCreate.generatedNotAddressable": {
			EN: `the generated window name "{name}" is not addressable`,
			KO: `생성된 창 이름 "{name}" 은(는) 주소로 쓸 수 없습니다`,
		},
		"wails.windowCreate.initQueryHasHash": {
			EN: `init query contains '#'; everything after it never reaches location.search: "{init}"`,
			KO: `init 쿼리에 '#' 이 있습니다 — 그 뒤는 location.search 에 도달하지 않습니다: "{init}"`,
		},
		"wails.windowCreate.initQueryLeadingMark": {
			EN: `init query starts with '?'; it is joined onto the URL with one already: "{init}"`,
			KO: `init 쿼리가 '?' 로 시작합니다 — URL 에 이미 '?' 가 붙어 결합됩니다: "{init}"`,
		},
		"wails.windowCreate.generatedHeld": {
			EN: "the generated window name {name} is already held; the identifier source produced a repeat",
			KO: "생성된 창 이름 {name} 은(는) 이미 사용 중입니다 — 식별자 소스가 같은 값을 다시 냈습니다",
		},
		"wails.window.runLoopNotStarted": {
			EN: "the application run loop has not started",
			KO: "앱 런 루프가 시작되지 않았습니다",
		},
		"wails.window.notFound": {
			EN: "window not found: {window}",
			KO: "창을 찾을 수 없습니다: {window}",
		},
		"wails.window.noNativeLifetime": {
			EN: "window {window} has no native lifetime; nothing can be done to it",
			KO: "창 {window} 에 네이티브 수명이 없습니다 — 아무 동작도 수행할 수 없습니다",
		},
	})
}

// The refusals the one window host answers with. A window with no native
// lifetime is named as such, so a caller does not read the absence as a
// completed effect.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.host.noContentArea": {
			EN: "window {window} has no native lifetime and no content area",
			KO: "창 {window} 에 네이티브 수명이 없어 콘텐츠 영역도 없습니다",
		},
		"wails.host.noViewToFit": {
			EN: "window {window} has no native lifetime and holds no view to fit",
			KO: "창 {window} 에 네이티브 수명이 없어 맞출 뷰가 없습니다",
		},
		"wails.host.noView": {
			EN: "window {window} has no native lifetime and holds no view",
			KO: "창 {window} 에 네이티브 수명이 없어 뷰가 없습니다",
		},
		"wails.host.cannotColour": {
			EN: "window {window} has no native lifetime and cannot be coloured",
			KO: "창 {window} 에 네이티브 수명이 없어 배경색을 지정할 수 없습니다",
		},
		"wails.host.noTitle": {
			EN: "window {window} has no native lifetime and no title",
			KO: "창 {window} 에 네이티브 수명이 없어 제목도 없습니다",
		},
		"wails.host.noWindowReturned": {
			EN: "the framework returned no window for {window}",
			KO: "프레임워크가 {window} 에 대한 창을 반환하지 않았습니다",
		},
		"wails.host.cannotReveal": {
			EN: "window {window} cannot be revealed; it has no native lifetime",
			KO: "창 {window} 을(를) 표시할 수 없습니다 — 네이티브 수명이 없습니다",
		},
		"wails.host.cannotWithdraw": {
			EN: "window {window} cannot be withdrawn; this process does not hold it",
			KO: "창 {window} 을(를) 회수할 수 없습니다 — 이 프로세스가 보유하고 있지 않습니다",
		},
		"wails.host.cannotPlace": {
			EN: "window {window} cannot be placed; it has no native lifetime",
			KO: "창 {window} 을(를) 배치할 수 없습니다 — 네이티브 수명이 없습니다",
		},
		"wails.host.cannotFocus": {
			EN: "window {window} cannot be focused; it has no native lifetime",
			KO: "창 {window} 에 포커스를 줄 수 없습니다 — 네이티브 수명이 없습니다",
		},
		"wails.host.cannotReload": {
			EN: "window {window} cannot be reloaded; it has no native lifetime",
			KO: "창 {window} 을(를) 다시 불러올 수 없습니다 — 네이티브 수명이 없습니다",
		},
		"wails.host.cannotClose": {
			EN: "window {window} cannot be closed; it has no native lifetime",
			KO: "창 {window} 을(를) 닫을 수 없습니다 — 네이티브 수명이 없습니다",
		},
		"wails.host.runLoopNotStarted": {
			EN: "the application cannot be activated before its run loop starts",
			KO: "런 루프가 시작되기 전에는 애플리케이션을 활성화할 수 없습니다",
		},
	})
}

// The refusals window capture answers with. What is missing is named, so a
// caller does not read a missing window or path as an empty image.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.capture.unsupportedPlatform": {
			EN: "window capture is not implemented on this platform",
			KO: "이 플랫폼에는 창 캡처가 구현되어 있지 않습니다",
		},
		"wails.capture.noWindowSource": {
			EN: "capture has no window source",
			KO: "capture 에 창 소스가 없습니다",
		},
		"wails.capture.beforeWindow": {
			EN: "capture ran before the window existed",
			KO: "창이 생기기 전에 capture 가 실행되었습니다",
		},
		"wails.capture.noPath": {
			EN: "capture needs a path to write to",
			KO: "capture 에는 기록할 경로가 필요합니다",
		},
		"wails.capture.needsWindow": {
			EN: "capture needs a window: name one, or call from a window",
			KO: "capture 에는 창이 필요합니다 — 창을 지정하거나 창 안에서 호출하십시오",
		},
		"wails.capture.noPixels": {
			EN: "window {window} has no native lifetime and no pixels",
			KO: "창 {window} 에 네이티브 수명이 없어 픽셀도 없습니다",
		},
		"wails.capture.nilWindow": {
			EN: "window capture received a nil window",
			KO: "창 캡처가 nil 창을 받았습니다",
		},
		"wails.capture.noImage": {
			EN: "window capture produced no image",
			KO: "창 캡처가 이미지를 만들지 못했습니다",
		},
	})
}

// The refusals the single-window dispatch answers with. A request that was
// never delivered is refused here rather than waiting out its deadline, so a
// caller reads which window is missing.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.dispatch.noSuchWindow": {
			EN: "this process holds no window named {window}",
			KO: "이 프로세스에는 {window} 라는 이름의 창이 없습니다",
		},
		"wails.dispatch.noNativeLifetime": {
			EN: "window {window} has no native lifetime",
			KO: "창 {window} 에 네이티브 수명이 없습니다",
		},
	})
}
