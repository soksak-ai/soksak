# 성능 헌법 — 상호작용 성능 원칙

soksak 의 상호작용 성능을 지키는 7가지 원칙. 모든 프런트엔드 코드 변경은 이
문서를 기준으로 리뷰한다. 위반은 "동작하니까 통과"가 아니라 결함이다.

배경: 2026-06 전수조사에서 가벼운 상호작용(디바이더/탭/사이드바 드래그, 스크롤)
만으로 WebContent CPU 가 ~100% 까지 오르는 구조적 원인 10건(R1~R10)이 확인됐다.
원인은 전부 아래 원칙의 위반이었다. 측정 하니스는 `scripts/perf/` 참조.

정본은 영문 [`PERFORMANCE.md`](./PERFORMANCE.md)다. 두 벌이 어긋나면 영문이 이긴다.

## 원칙

### 1. 구독 최소

컴포넌트는 렌더에 실제로 쓰는 데이터에만 셀렉터로 구독한다.

- 금지: `useSessions()` / `useSettings()` 등 셀렉터 없는 bare 훅 — 스토어의 모든
  쓰기가 그 컴포넌트(와 전 자식)를 리렌더시킨다.
- `useSessions.subscribe(cb)` 류 store 전체 구독도 동일 — 콜백이 모든 쓰기마다
  실행되므로, 비싼 콜백은 프레임 단위로 coalesce 한다(원칙 4·5).
- 다중 필드가 필요하면 `useShallow` 픽. 액션은 정의 시점에 고정되는 안정 참조라
  액션별 셀렉터가 안전하다.

### 2. 렌더 경계 = 데이터 경계

`React.memo` 경계는 데이터 소유 단위와 일치시킨다(GroupArea=content,
FileViewer=view, ProjectPane=project …). 경계를 넘는 prop 은 참조 안정성을
보장한다(useCallback/안정 셀렉터/ref 경유). 커스텀 비교자는 금지 — staleness
버그의 온상이다. 기본 shallow compare 로 성립하지 않는 memo 는 설계가 틀린 것.

### 3. 일시 상태와 영속 상태의 분리

제스처(드래그) 중간값은 일시 상태다. 스토어(영속 상태) 커밋은 제스처 종료 시
1회, 또는 시각 추종이 필요하면 프레임당 1회를 상한으로 한다. 매 mousemove 마다
스토어에 쓰는 코드는 금지.

### 4. 고빈도 이벤트는 프레임당 1회

mousemove/dragover/스크롤 연동 등 연속 입력 핸들러는 `rafThrottle`(src/lib)로
프레임당 1회로 합친다. 제스처 종료 시 `flush()` 로 마지막 값을 반드시 커밋한다
(리스너 제거 전에 — 아니면 마지막 프레임이 유실돼 스냅백한다).

### 5. 비싼 부수효과는 정착 후 1회

IPC(invoke)·PTY resize(SIGWINCH)·네이티브 웹뷰 이동/리사이즈는 trailing
debounce 로 입력이 정착한 뒤 1회 실행한다. 스톰은 본구간 CPU 뿐 아니라
**지연 스파이크**(예: SIGWINCH 수백 발 → TUI 가 수 초간 연쇄 재그리기)를 만든다.
강제 레이아웃 읽기(getBoundingClientRect 등)는 매 렌더 동기 실행 금지 — rAF
타이밍으로 옮긴다.

#### 5a. 제스처 중 시각 연속성 (freeze-frame)

네이티브 표면의 bounds 커밋 유예(위의 정착-후-1회)가 시각 공백을 노출해서는
안 된다: 제스처 동안 슬롯은 라이브로 움직이는데 아래 네이티브 표면은 옛
bounds 에 머물러 화면이 찢기거나 비어 보인다. 규칙: 사용자 제스처는 결코
불연속 콘텐츠를 보여주지 않는다.

- 코어는 제스처 사실(`layout.resize-gesture` 플러그인 이벤트, 시작/끝)과 캡처
  능력(`app.webview.captureRegion`)만 제공한다. 제공자가 무엇을 하는지는 코어가
  모른다.
- 네이티브 표면 제공자는 제스처 동안 슬롯을 스탠드인으로 덮는다: 시작 시 슬롯을
  캡처해 top-left 앵커·무스케일로 불투명 컨테이너 안에 표시하고(슬롯이 자라며
  아래 stale 네이티브가 드러나지 않게), 끝에 bounds 를 정확히 1회 커밋하고,
  네이티브 재페인트 후 스탠드인을 제거한다. 캡처 실패 시 콘텐츠를 비우는 대신
  기존 동작으로 폴백한다.
- 엔진 사이드카 표면(코어 layer 밖, DOM 위 합성)은 릴레이가 아니라 제공자
  플러그인이 오케스트레이션한다: 스탠드인을 마운트한 뒤에 표면을 숨기고(숨김이
  먼저면 캡처 도착까지 팬이 빈다), 표면을 복원한 뒤에 스탠드인을 걷는다.
  사이드카 host-fact 릴레이(`resize-gesture`)는 DOM 측 제공자가 없는 엔진을
  위해 존재한다.
- 아래 [HARD] 규칙과 상충하지 않는다: 스탠드인은 유예된 리사이즈를 잇는
  의도적·일시적 시각 다리이고 종착 상태는 진짜 재페인트다 — 렌더 아티팩트의
  은폐가 아니다.

### 6. 플랫폼 페인트 경로 보존

WebKit 의 합성(비동기) 스크롤·합성 레이어를 깨는 CSS 를 금지한다. 대표:
전역 `::-webkit-scrollbar` 커스텀(레거시 스크롤바 경로 강제). 스크롤바 스타일은
표준 `scrollbar-width`/`scrollbar-color` 를 우선한다. 의심 패턴은 반드시
하니스 A/B 측정으로 검증 후 적용한다.

### 7. 측정 없이 완료 없음

성능에 닿는 변경은 `scripts/perf/run.sh` 의 before/after 수치를 동반해야 한다.
시나리오(S1~S7)와 게이트 절차는 `scripts/perf/README.md` 참조. 본구간(active)과
테일(tail) 둘 다 본다 — 테일 악화는 부수효과 스톰의 신호다.

## 플러그인 성능 계약

플러그인 이벤트 핸들러(`onDidChangeActiveView` 등)는 **메인스레드에서 동기
실행**된다. 무거운 작업(파싱, 네트워크 후처리, 대량 DOM)은 핸들러 안에서 직접
하지 말고 defer 한다. 호스트는 상태 diff 를 프레임 단위로 coalesce 해 전달하므로
이벤트는 "최종 상태" 기준이다 — 틱 단위 중간값에 의존하지 말 것.

## 터미널 렌더러 — WKWebView 합성 stretch (불변식)

증상: macOS 창 가장자리 드래그(라이브 리사이즈) 중 터미널 글자가 늘어난다(흐릿한
확대). DOM(탭·사이드바)은 멀쩡한데 터미널만.

근본 원인: 라이브 리사이즈 동안 AppKit 은 `inLiveResize` 로 redraw 를 멈추고, GPU
합성 레이어(WebGL/Canvas 렌더러의 `<canvas>`)를 새 창 크기로 CALayer 스케일한다
(`layerContentsRedrawPolicy` 가 명시적 redraw 없으면 콘텐츠를 stretch). DOM 은 WebKit
이 타일을 매 프레임 재래스터하므로 또렷하다. Chromium 은 리사이즈 콜백에서 동기
페인트로 회피하지만 WKWebView 엔 그 경로가 없어 Safari 에도 같은 증상이 있다. 즉
**WKWebView + GPU 캔버스는 리사이즈 stretch 를 구조적으로 못 피한다** — 그 캔버스는
WebKit 내부 합성 레이어라 우리가 contentsGravity 를 만질 수 없다.

규칙:

- 기본 터미널 렌더러는 WebGL(`xtermRenderer: "webgl"`) — 처리량 우선(사용자 기본값).
  단 창 리사이즈 중 합성 stretch 가 따라온다(원인은 위). 정확성보다 처리량을 택한
  기본값이다.
- DOM 은 리사이즈 정확성이 필요할 때 전환 — WebKit 이 DOM 을 매 프레임 재래스터해
  안 늘어난다. 설정의 "터미널 렌더러" 또는
  `sok settings.set '{"key":"xtermRenderer","value":"dom"}'`. 살아있는 터미널에
  라이브 전환된다(WebGL addon load/dispose).
- [HARD] stretch 를 "본문을 가려서" 숨기는 류의 우회는 금지 — 은폐는 해결이 아니다.
  렌더러 선택(DOM)만이 근본 해법이다. (5a 의 제스처 스탠드인은 이에 해당하지
  않는다: 유예된 리사이즈를 잇고 진짜 재페인트로 끝난다.)

근거(2026-06 조사, URL 검증 완료):

- NSView.LayerContentsRedrawPolicy — `never`/`onSetNeedsDisplay` 는 명시적 redraw
  없으면 레이어 콘텐츠를 리사이즈 시 stretch(`duringViewResize` 는 매 프레임 redraw):
  <https://developer.apple.com/documentation/appkit/nsview/layercontentsredrawpolicy-swift.enum>
- Cocoa Live Window Resizing — `inLiveResize`, 콘텐츠 보존은 opt-in 최적화:
  <https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CocoaPerformance/Articles/CocoaLiveResize.html>
- MTKView/SKView 라이브 리사이즈 콘텐츠 stretch(CALayer contentsGravity + redraw 중단):
  <https://developer.apple.com/forums/thread/94765>
- servo/webrender #1640 — macOS 는 "리사이즈 콜백에서 반환 전에 한 프레임을 그려야"
  한다(동기 페인트 부재 시 콘텐츠가 lag/scale): <https://github.com/servo/webrender/issues/1640>

코드 앵커: 렌더러 선택은 터미널 플러그인(soksak-plugin-terminal-xterm,
`src/terminal.ts` `xtermRenderer`) 소유.
