package wails

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this framework answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.presentation.invalid": {
			EN: "invalid application presentation mode: {mode}",
			KO: "잘못된 application presentation mode입니다: {mode}",
		},
		"wails.identity.missing": {
			EN: "application identity is required before creating a window",
			KO: "창을 만들기 전에 application identity가 필요합니다",
		},
		"wails.clipboard.readRefused": {
			EN: "the framework clipboard refused to read text",
			KO: "framework clipboard가 text 읽기를 거부했습니다",
		},
		"wails.clipboard.writeRefused": {
			EN: "the framework clipboard refused to write text",
			KO: "framework clipboard가 text 쓰기를 거부했습니다",
		},
		"wails.window.invalidClientRect": {EN: "window client rect has no area: {width}x{height}", KO: "창 client rect에 면적이 없습니다: {width}x{height}"},
		"wails.window.noClientDPI":       {EN: "window client rect has no DPI", KO: "창 client rect에 DPI가 없습니다"},
		"wails.input.negativeCoordinates": {
			EN: "window input coordinates must be non-negative: x={x}, y={y}",
			KO: "창 입력 좌표는 0 이상이어야 합니다: x={x}, y={y}",
		},
		"wails.input.emptyKey": {
			EN: "window input key must not be empty",
			KO: "창 입력 key는 비어 있을 수 없습니다",
		},
		"wails.input.nativeDeliveryFailed": {
			EN: "native window input failed: {reason}",
			KO: "native 창 입력 실패: {reason}",
		},
		"wails.input.invalidTimeout": {
			EN: "timeoutMs must be between 1 and 30000: {timeout}",
			KO: "timeoutMs는 1에서 30000 사이여야 합니다: {timeout}",
		},
		"wails.input.pointerTimeout": {
			EN: "mouseup was not observed for sequence {sequence} within {timeout}",
			KO: "sequence {sequence}의 mouseup이 {timeout} 안에 확인되지 않았습니다",
		},
		"wails.input.invalidPhase": {
			EN: "pointer phase must be down, move or up: {phase}",
			KO: "포인터 phase는 down, move 또는 up이어야 합니다: {phase}",
		},
		"wails.input.invalidSteps": {
			EN: "pointer drag steps must be between 1 and 120: {steps}",
			KO: "포인터 드래그 steps는 1 이상 120 이하여야 합니다: {steps}",
		},
		"wails.input.invalidDuration": {
			EN: "pointer drag durationMs must be between 0 and 10000: {duration}",
			KO: "포인터 드래그 durationMs는 0 이상 10000 이하여야 합니다: {duration}",
		},
		"wails.input.windowUnknown": {
			EN: "the pointer event has no associated window",
			KO: "포인터 이벤트에 연결된 창이 없습니다",
		},
		"wails.input.monitorInactive": {
			EN: "the window input monitor is not active",
			KO: "창 입력 모니터가 활성 상태가 아닙니다",
		},
		"wails.input.stateFailed": {
			EN: "window input state failed: {reason}",
			KO: "창 입력 상태 조회 실패: {reason}",
		},
		"wails.input.markFailed": {
			EN: "IME composition update failed: {reason}",
			KO: "IME 조합 상태 변경 실패: {reason}",
		},
		"wails.decoration.pathCoordinateMissing": {
			EN: "native decoration path ends before coordinate {index}",
			KO: "native decoration path가 coordinate {index} 전에 끝났습니다",
		},
		"wails.decoration.pathCoordinateInvalid": {
			EN: "native decoration path coordinate {value} is not finite",
			KO: "native decoration path coordinate {value}가 유한한 수가 아닙니다",
		},
		"wails.decoration.pathEmpty": {
			EN: "native decoration path is empty",
			KO: "native decoration path가 비었습니다",
		},
		"wails.decoration.pathOperation": {
			EN: "native decoration path operation {operation} is not M, L, Q or Z",
			KO: "native decoration path operation {operation}은 M, L, Q, Z 중 하나가 아닙니다",
		},
		"wails.decoration.pathStart": {
			EN: "native decoration path does not begin with M",
			KO: "native decoration path가 M으로 시작하지 않습니다",
		},
		"wails.decoration.idEmpty": {
			EN: "native decoration id is empty",
			KO: "native decoration id가 비었습니다",
		},
		"wails.decoration.idDuplicate": {
			EN: "native decoration id {id} is duplicated",
			KO: "native decoration id {id}가 중복되었습니다",
		},
		"wails.decoration.color": {
			EN: "native decoration {id} has a colour channel outside 0..1",
			KO: "native decoration {id}의 color channel이 0..1 범위 밖입니다",
		},
		"wails.decoration.strokeWidth": {
			EN: "native decoration {id} has a stroke width outside 0.5..8",
			KO: "native decoration {id}의 stroke width가 0.5..8 범위 밖입니다",
		},
		"wails.decoration.dash": {
			EN: "native decoration {id} has an invalid dash",
			KO: "native decoration {id}의 dash가 올바르지 않습니다",
		},
		"wails.decoration.hostUnavailable": {
			EN: "native decoration host is unavailable",
			KO: "native decoration host를 사용할 수 없습니다",
		},
		"wails.decoration.windowUnavailable": {
			EN: "native decoration window {window} has no native lifetime",
			KO: "native decoration window {window}에 native lifetime이 없습니다",
		},
		"wails.decoration.allocation": {
			EN: "native decoration memory allocation failed for {kind}",
			KO: "native decoration {kind} memory allocation에 실패했습니다",
		},
		"wails.decoration.nativeRefused": {
			EN: "native decoration plane refused with status {status}",
			KO: "native decoration plane이 status {status}로 거부했습니다",
		},
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
		"wails.renderer.refusedWithDetail": {
			EN: `window {window} refused {command} — {code}: {message} ({detail})`,
			KO: `창 {window} 이(가) {command} 을(를) 거부했습니다 — {code}: {message} ({detail})`,
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
		"wails.window.revealWithoutKeyFailed": {
			EN: "Windows did not show the window without activation",
			KO: "Windows가 창을 활성화하지 않고 표시하지 못했습니다",
		},
		"wails.window.captureOnlyPresentationFailed": {
			EN: "the native window did not enter transparent, input-free capture-only presentation",
			KO: "네이티브 창이 투명하고 입력을 받지 않는 capture-only 표시 상태에 들어가지 못했습니다",
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
		"wails.window.noNativeClose": {
			EN: "the window has no native close button",
			KO: "이 창에는 네이티브 닫기 버튼이 없습니다",
		},
		"wails.window.nativeCloseDisabled": {
			EN: "the native close button is disabled or hidden",
			KO: "네이티브 닫기 버튼이 비활성화되었거나 숨겨졌습니다",
		},
		"wails.window.nativeCloseClickFailed": {
			EN: "AppKit rejected the native close-button mouse input",
			KO: "AppKit이 네이티브 닫기 버튼 마우스 입력을 거부했습니다",
		},
		"wails.input.nativeCloseTimeout": {
			EN: "native close did not destroy its window for sequence {sequence} within {timeout}",
			KO: "네이티브 닫기 sequence {sequence}이(가) {timeout} 안에 창을 종료하지 않았습니다",
		},
		"wails.input.nativeCloseExpectationMissing": {
			EN: "native close sequence {sequence} was never registered",
			KO: "네이티브 닫기 sequence {sequence}이(가) 등록되지 않았습니다",
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
			KO: "창 {window} 을(를) 정리할 수 없습니다. 이 프로세스가 보유하고 있지 않습니다",
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
		"wails.host.cannotInspect": {
			EN: "window {window} has no inspector; it has no native lifetime",
			KO: "창 {window} 에는 검사기가 없습니다 — 네이티브 수명이 없습니다",
		},
		"wails.host.noInspector": {
			EN: "this build has no inspector — build with the devtools tag",
			KO: "이 빌드에는 검사기가 없습니다 — devtools 태그로 빌드하십시오",
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
		"wails.surface.needsWindow": {
			EN: "a surface reading needs a window: name one, or call from a window",
			KO: "서피스 조회에는 창이 필요합니다 — 창을 지정하거나 창 안에서 호출하십시오",
		},
		"wails.capture.noPixels": {
			EN: "window {window} has no native lifetime and no pixels",
			KO: "창 {window} 에 네이티브 수명이 없어 픽셀도 없습니다",
		},
		"wails.capture.nilWindow": {
			EN: "native capture received a nil window",
			KO: "네이티브 캡처에 창이 전달되지 않았습니다",
		},
		"wails.capture.noFrame":             {EN: "native capture returned no frame", KO: "네이티브 캡처가 프레임을 반환하지 않았습니다"},
		"wails.capture.invalidFrame":        {EN: "invalid native capture frame: {width}x{height} stride={stride} bytes={bytes}", KO: "잘못된 네이티브 캡처 프레임입니다: {width}x{height} stride={stride} bytes={bytes}"},
		"wails.capture.noPNG":               {EN: "native capture encoded no PNG bytes", KO: "네이티브 캡처가 PNG 바이트를 인코딩하지 못했습니다"},
		"wails.capture.invalidExtent":       {EN: "invalid capture extent or scale", KO: "캡처 범위 또는 배율이 잘못되었습니다"},
		"wails.capture.invalidRegion":       {EN: "capture region must have positive width and height", KO: "캡처 영역의 너비와 높이는 양수여야 합니다"},
		"wails.capture.emptyRegion":         {EN: "capture region is empty after clamping", KO: "범위를 적용한 뒤 캡처 영역이 비었습니다"},
		"wails.capture.windowsEmptyExtent":  {EN: "Windows capture received an empty window extent", KO: "Windows 캡처가 빈 창 범위를 받았습니다"},
		"wails.capture.windowsDC":           {EN: "Windows capture could not create a device context: {reason}", KO: "Windows 캡처가 device context를 만들지 못했습니다: {reason}"},
		"wails.capture.windowsBitmap":       {EN: "Windows capture could not create a bitmap", KO: "Windows 캡처가 bitmap을 만들지 못했습니다"},
		"wails.capture.windowsSelectBitmap": {EN: "Windows capture could not select its bitmap", KO: "Windows 캡처가 bitmap을 선택하지 못했습니다"},
		"wails.capture.windowsPrint":        {EN: "Windows PrintWindow failed: {reason}", KO: "Windows PrintWindow가 실패했습니다: {reason}"},
		"wails.capture.wordlessRefusal": {
			EN: "the capture refused and said nothing; the reason is missing at its source",
			KO: "캡처가 이유 없이 거절했습니다 — 사유가 그 출처에서 빠져 있습니다",
		},
		"wails.capture.noImage": {
			EN: "window capture produced no image",
			KO: "창 캡처가 이미지를 만들지 못했습니다",
		},
	})
}

// The refusals a recording answers with. Every bound is named with the value
// that missed it and with the range, because a caller who is told only that a
// number was refused cannot tell whether to raise it or lower it. Nothing is
// clamped: a burst quietly shortened to fit is a burst of something other than
// what was asked for, and the frames look the same either way.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.record.noDir": {
			EN: "a recording needs a directory to write its frames into",
			KO: "녹화에는 프레임을 기록할 디렉터리가 필요합니다",
		},
		"wails.record.framesOutOfRange": {
			EN: "a recording takes 1 through {max} frames; {given} is outside that and is not clamped to it",
			KO: "녹화는 1 에서 {max} 프레임까지입니다 — {given} 은(는) 그 밖이며 범위로 잘라내지 않습니다",
		},
		"wails.record.intervalOutOfRange": {
			EN: "a recording interval is 0 through {max}ms; {given}ms is outside that and is not clamped to it",
			KO: "녹화 간격은 0 에서 {max}ms 까지입니다 — {given}ms 는 그 밖이며 범위로 잘라내지 않습니다",
		},
		"wails.record.budgetOutOfRange": {
			EN: "a recording budget is 1 through {max} bytes; {given} is outside that",
			KO: "녹화 용량 한도는 1 에서 {max} 바이트까지입니다 — {given} 은(는) 그 밖입니다",
		},
		"wails.record.deadlineOutOfRange": {
			EN: "a frame deadline is 1 through {max}ms; {given}ms is outside that",
			KO: "프레임 기한은 1 에서 {max}ms 까지입니다 — {given}ms 는 그 밖입니다",
		},
		"wails.record.frameLate": {
			EN: "the frame did not arrive within {deadline}",
			KO: "프레임이 {deadline} 안에 도착하지 않았습니다",
		},
	})
}

// The refusals a reading of a recording answers with. A reading is asked for by
// name and answered by name, so a region with no name and two regions sharing
// one are both refused before a frame is opened — an answer keyed by position
// would be read against the wrong region and nothing in it would say so.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"wails.analyze.noRegions": {
			EN: "a reading needs at least one region to read",
			KO: "판독에는 읽을 영역이 최소 하나 필요합니다",
		},
		"wails.analyze.regionUnnamed": {
			EN: "a region has no name; the answer is read by name, not by position",
			KO: "이름 없는 영역이 있습니다 — 답은 위치가 아니라 이름을 기준으로 읽습니다",
		},
		"wails.analyze.regionNameRepeated": {
			EN: "two regions are named {name}; one name answers with one series",
			KO: "{name} 이름의 영역이 둘입니다 — 한 이름은 한 계열로 답합니다",
		},
		"wails.analyze.regionOutsideFrame": {
			EN: "region {name} is x{x} y{y} {w}x{h}; a region is a fraction of the frame inside 0..1",
			KO: "영역 {name} 은(는) x{x} y{y} {w}x{h} 입니다 — 영역은 0..1 안의 프레임 비율입니다",
		},
		"wails.analyze.regionEmpty": {
			EN: "region {name} is {w}x{h} pixels in a {frameW}x{frameH} frame; there is nothing there to read",
			KO: "영역 {name} 은(는) {frameW}x{frameH} 프레임 안에서 {w}x{h} 픽셀입니다 — 읽을 것이 없습니다",
		},
		"wails.analyze.thresholdOutOfRange": {
			EN: "a change threshold is a luminance difference from 0 through 1; {given} is outside that",
			KO: "변화 임계값은 0 에서 1 사이의 휘도 차입니다 — {given} 은(는) 그 밖입니다",
		},
		"wails.analyze.noDir": {
			EN: "a reading needs the directory the frames were recorded into",
			KO: "판독에는 프레임이 기록된 디렉터리가 필요합니다",
		},
		"wails.analyze.dirUnreadable": {
			EN: "no recording in {dir}: {first} could not be read ({cause})",
			KO: "{dir} 에 녹화가 없습니다 — {first} 을(를) 읽을 수 없습니다 ({cause})",
		},
		"wails.analyze.firstFrameMissing": {
			EN: "no recording in {dir}: {first} is not there",
			KO: "{dir} 에 녹화가 없습니다 — {first} 이(가) 없습니다",
		},
		"wails.analyze.frameGap": {
			EN: "{missing} is missing and {present} is not; a gap makes two frames adjacent that were not",
			KO: "{missing} 이(가) 없고 {present} 은(는) 있습니다 — 빈칸은 이웃이 아니던 두 프레임을 이웃으로 만듭니다",
		},
		"wails.analyze.frameSizeChanged": {
			EN: "frame {number} is {w}x{h} and frame {first} is {firstW}x{firstH}; " +
				"one recording is one size, and a region is a different rectangle in each",
			KO: "프레임 {number} 은(는) {w}x{h} 이고 프레임 {first} 은(는) {firstW}x{firstH} 입니다 — " +
				"한 녹화는 한 크기이며, 영역은 각각에서 다른 사각형이 됩니다",
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
	i18n.Declare(map[string]i18n.Sentence{
		// What a renderer is told when its command declaration cannot be taken.
		"wails.declare.noWindow": {
			EN: "a command declaration arrived with no window to attribute it to",
			KO: "명령 선언이 도착했으나 귀속할 창이 없습니다",
		},
		"wails.declare.noNames": {
			EN: `the declaration carried no "{field}" list`,
			KO: `선언에 "{field}" 목록이 없습니다`,
		},
		"wails.declare.notTold": {
			EN: "these windows were not told what they hold: {windows}",
			KO: "다음 창들은 자기가 무엇을 가졌는지 통지받지 못했습니다: {windows}",
		},
		"wails.rendererWait.invalidTimeout": {
			EN: "renderer wait timeout must be between 1 and 60000 milliseconds",
			KO: "renderer 대기 제한 시간은 1~60000밀리초여야 합니다",
		},
		"wails.rendererWait.timeout": {
			EN: "window {window} did not declare its renderer commands before the deadline",
			KO: "창 {window}이(가) 제한 시간 안에 renderer 명령을 선언하지 않았습니다",
		},
		"wails.rendererWait.closed": {
			EN: "window {window} closed before declaring its renderer commands",
			KO: "창 {window}이(가) renderer 명령을 선언하기 전에 닫혔습니다",
		},
		"wails.pluginFile.noRoots": {
			EN: "settings declares no active plugin path",
			KO: "설정에 활성 플러그인 경로가 없습니다",
		},
		"wails.pluginFile.noPath": {
			EN: `the request carries no "{field}", so there is nothing to read`,
			KO: `요청에 "{field}" 가 없어 읽을 대상이 없습니다`,
		},
		"wails.pluginFile.relative": {
			EN: "{path} is relative; a plugin file requires an absolute path",
			KO: "{path} 이(가) 상대 경로입니다. 플러그인 파일은 절대 경로가 필요합니다",
		},
		"wails.pluginFile.undeclared": {
			EN: "{path} is not inside an active plugin path declared by settings",
			KO: "{path} 이(가) 설정에 선언된 활성 플러그인 경로 안에 없습니다",
		},
	})

}
