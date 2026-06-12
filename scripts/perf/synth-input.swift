// 퍼포먼스 하니스 입력 합성기 — CGEvent 로 실제 마우스 드래그/스크롤을 만든다.
// sok 명령으로 못 만드는 시나리오(창 리사이즈, 사이드바 드래그, 스크롤)용.
//
// 빌드:  swiftc -O scripts/perf/synth-input.swift -o scripts/perf/.build/synth-input
// 권한:  최초 1회 손쉬운 사용(Accessibility) 허용 필요(터미널 앱에).
//
// 사용:
//   synth-input move <x> <y>
//   synth-input drag <x1> <y1> <x2> <y2> <ms> [hz]
//   synth-input scroll <x> <y> <dy> <count> <intervalMs>
//   synth-input winbounds <appName>          — 앱 첫 윈도우 {x,y,w,h} JSON 출력
//
// 좌표는 화면 전역(좌상단 원점, pt).

import AppKit
import CoreGraphics
import Foundation

func die(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func post(_ ev: CGEvent?) {
    ev?.post(tap: .cghidEventTap)
}

func mouseEvent(_ type: CGEventType, _ p: CGPoint) -> CGEvent? {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
}

func sleepMs(_ ms: Double) {
    usleep(useconds_t(ms * 1000))
}

func move(to p: CGPoint) {
    post(mouseEvent(.mouseMoved, p))
}

// 자연스러운 드래그: down → hz 빈도로 보간 이동 → up. 실제 사용자 드래그와 동일하게
// mousemove 이벤트가 연속 발생한다.
func drag(from a: CGPoint, to b: CGPoint, ms: Double, hz: Double) {
    move(to: a)
    sleepMs(60)
    post(mouseEvent(.leftMouseDown, a))
    sleepMs(40)
    let steps = max(2, Int(ms / 1000.0 * hz))
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        post(mouseEvent(.leftMouseDragged, p))
        sleepMs(ms / Double(steps))
    }
    post(mouseEvent(.leftMouseUp, b))
    sleepMs(40)
}

func scroll(at p: CGPoint, dy: Int32, count: Int, intervalMs: Double) {
    move(to: p)
    sleepMs(80)
    for i in 0..<count {
        // 픽셀 단위 연속 스크롤(트랙패드와 유사). 방향을 주기적으로 반전해
        // 같은 지점을 왕복 — 멱등(끝나면 제자리 부근).
        let dir: Int32 = (i / max(1, count / 4)) % 2 == 0 ? dy : -dy
        let ev = CGEvent(
            scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
            wheel1: dir, wheel2: 0, wheel3: 0)
        post(ev)
        sleepMs(intervalMs)
    }
}

// 앱 첫 윈도우 AXUIElement.
func firstWindow(appName: String) -> (AXUIElement, pid_t) {
    guard let app = NSWorkspace.shared.runningApplications.first(where: {
        $0.localizedName == appName
            || $0.bundleIdentifier?.hasSuffix(appName) == true
            || ($0.executableURL?.lastPathComponent ?? "") == appName
    }) else { die("앱을 찾지 못함: \(appName)") }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var winsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &winsRef) == .success,
        let wins = winsRef as? [AXUIElement], let win = wins.first
    else { die("윈도우 없음(손쉬운 사용 권한 확인): \(appName)") }
    return (win, app.processIdentifier)
}

// 앱 첫 윈도우 프레임(AX API). 손쉬운 사용 권한 필요.
func winBounds(appName: String) {
    let (win, pid) = firstWindow(appName: appName)
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &posRef)
    AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &sizeRef)
    var pos = CGPoint.zero
    var size = CGSize.zero
    if let pr = posRef { AXValueGetValue(pr as! AXValue, .cgPoint, &pos) }
    if let sr = sizeRef { AXValueGetValue(sr as! AXValue, .cgSize, &size) }
    print("{\"x\":\(pos.x),\"y\":\(pos.y),\"w\":\(size.width),\"h\":\(size.height),\"pid\":\(pid)}")
}

// 윈도우 위치/크기 설정(측정 표준화 — 좌표 결정성).
func setWin(appName: String, x: Double, y: Double, w: Double, h: Double) {
    let (win, _) = firstWindow(appName: appName)
    var pos = CGPoint(x: x, y: y)
    var size = CGSize(width: w, height: h)
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pos)!)
    AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
}

// ── main ──
let args = CommandLine.arguments.dropFirst()
guard let cmd = args.first else { die("사용법: move|drag|scroll|winbounds") }
let rest = Array(args.dropFirst())

// 입력 합성 명령은 손쉬운 사용 신뢰가 필요하다(winbounds 포함).
if !AXIsProcessTrusted() {
    FileHandle.standardError.write(
        "경고: 손쉬운 사용(Accessibility) 권한이 없습니다. 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 이 터미널을 허용하세요.\n"
            .data(using: .utf8)!)
}

switch cmd {
case "move":
    guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else { die("move <x> <y>") }
    move(to: CGPoint(x: x, y: y))
case "drag":
    guard rest.count >= 5, let x1 = Double(rest[0]), let y1 = Double(rest[1]),
        let x2 = Double(rest[2]), let y2 = Double(rest[3]), let ms = Double(rest[4])
    else { die("drag <x1> <y1> <x2> <y2> <ms> [hz]") }
    let hz = rest.count >= 6 ? Double(rest[5]) ?? 90 : 90
    drag(from: CGPoint(x: x1, y: y1), to: CGPoint(x: x2, y: y2), ms: ms, hz: hz)
case "scroll":
    guard rest.count >= 5, let x = Double(rest[0]), let y = Double(rest[1]),
        let dy = Int32(rest[2]), let count = Int(rest[3]), let interval = Double(rest[4])
    else { die("scroll <x> <y> <dy> <count> <intervalMs>") }
    scroll(at: CGPoint(x: x, y: y), dy: dy, count: count, intervalMs: interval)
case "winbounds":
    guard let name = rest.first else { die("winbounds <appName>") }
    winBounds(appName: name)
case "setwin":
    guard rest.count >= 5, let x = Double(rest[1]), let y = Double(rest[2]),
        let w = Double(rest[3]), let h = Double(rest[4])
    else { die("setwin <appName> <x> <y> <w> <h>") }
    setWin(appName: rest[0], x: x, y: y, w: w, h: h)
default:
    die("알 수 없는 명령: \(cmd)")
}
