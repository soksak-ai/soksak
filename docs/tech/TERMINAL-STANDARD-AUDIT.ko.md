---
kind: translation
status: active
canonical: TERMINAL-STANDARD-AUDIT.md
---

# 터미널 표준 전수조사

이 보고서는 이전 터미널 표준 완료 주장을 모두 초기화합니다. 선택 engine의 source/API, owner 적합성
test, 설치된 command/status/event, 수치 상태 전이, 캡처 픽셀을 한 run에서 증명해야 GREEN입니다.
source에 코드가 있거나 unit test 하나가 통과한 사실만으로 완료 처리하지 않습니다.

터미널 계약이 필수 control sequence 동작과 선택적 image protocol capability를 정의합니다. 각 provider는
자신이 선언한 범위를 자기 저장소에서 증명하며 Core는 provider 구현을 열람하거나 검증하지 않습니다.

## Wails 포커스 조건 관측 — 2026-09-01

OS 창을 앞으로 가져오지 않은 개발용 Wails 창에서 관측했습니다. 활성 터미널 화면에 공개
`ui.input.click`을 실행한 뒤 `ui.focus.state`는 해당 탭을 키보드 소유자로 보고했고
`delivered=true`였습니다. 이어서 `ui.tree rects=true`는 마운트된 터미널 다섯 개 모두에
`surfaceReady=true`를 보고했습니다. 활성 탭(`tab-2mmxbp`)은
`cursorPresentation=engine`, `cursorActive=true`였고, 비활성 네 탭은
`cursorPresentation=hollow-block`, `cursorActive=false`였습니다. 같은 관측에서 보이는 각
native 터미널의 `nativeDeclaredFrame`은 DOM rect(`205,120,789,121`)와 일치했습니다.

이 캡처는 공개 DOM 클릭/포커스 조건과 포커스 아웃 커서 표현에 대해서는 GREEN입니다. OS native
마우스 클릭이나 AppKit 키보드 전달 전체를 인증하는 결과는 아닙니다. 창에 포커스를 빼앗지 않는
native 입력 관측을 별도로 측정하기 전까지 그 범위는 미완료로 둡니다.

## Theme 행 — 2026-08-29

실제 shell이 OSC 4/10/11/12를 출력하고 engine `surface.state`, plugin presentation status, 캡처 surface를
비교합니다. OSC 104/110/111/112는 override를 제거해야 합니다. Host dark/light 변경은 base를 갱신하고
non-null override를 보존하며, reset 뒤 현재 base가 나타나야 합니다.

| Provider | Baseline | OSC set/status | Reset | Pixel | 판정 |
| --- | --- | --- | --- | --- | --- |
| Alacritty | live, frame/output 증가 | `#123456/#234567/#345678`, ANSI 1 `#456789` 정확히 일치 | GREEN | GREEN | 이 행 GREEN |
| Ghostty | 즉시 입력과 다른 tab 왕복 뒤에도 42×30 live | 정확히 일치 | GREEN | GREEN | 이 행 GREEN |
| Kitty | output 및 다른 tab 왕복 뒤에도 42×30 live 유지 | `#123456/#234567/#345678`, ANSI 1 `#456789` 정확히 일치 | GREEN; override가 모두 null이고 현재 base 복원 | GREEN | 이 행 GREEN |
| Shitty | 42×30 live; output 270+, frames consumed 7+, paint 6+ | `#123456/#234567/#345678`, ANSI 1 `#456789` 정확히 일치 | GREEN; override가 모두 null이고 현재 base 복원 | GREEN | 이 행 GREEN |
| VT100 | 즉시 입력과 다른 tab 왕복 뒤에도 42×30 live | 정확히 일치 | GREEN | GREEN | 이 행 GREEN |
| WezTerm | 즉시 입력과 다른 tab 왕복 뒤에도 42×30 live | 정확히 일치 | GREEN | GREEN | 이 행 GREEN |
| Xterm renderer 6.0.0 | 59×29 live, 다른 tab 왕복 뒤 39×29 | `#123456/#234567/#345678`, ANSI 1 `#456789` 정확히 일치 | GREEN; 현재 light base 복원 | GREEN | 이 행 GREEN |

Alacritty는 dark→light에서 override를 유지하고 reset 후 light base로 돌아오는 것도 통과했습니다. 상태를
사실대로 만들기 위해 두 결함을 수정했습니다. Frame event limiter는 마지막 event를 한 번 전달하고,
effective theme는 JSON property 순서가 아니라 필드 값으로 비교합니다.

Shitty의 이전 `cell size failed: -1`은 engine 기능 미지원이 아니었습니다. Native surface grid가
terminal resize observation이 mirror에 도착하기 전에 paint를 시작했습니다. Kit 0.0.24는 기존 resize
event를 기다려 두 grid가 일치한 뒤에만 paint하며 polling도 범위 밖 cell read도 하지 않습니다. 여섯
native Sidecar owner가 같은 새 Kit gate를 통과했습니다. 설치한 Shitty 0.0.28 closure는 shell output과
cursor를 그렸고 OSC color 적용·reset 및 surface error 없음까지 보고했습니다.

그 다음 Kitty가 두 번째 공통 lifecycle 결함을 드러냈습니다. Compositor remove/create 알림이 declaration
generation ownership 없이 서로 다른 goroutine에서 실행되어, 늦은 이전 remove가 DOM에 계속 선언된 새
surface를 닫을 수 있었습니다. `wails-service-terminal-surface`는 이제 pane별 lifecycle을 직렬화하고
Start·Remove·drop에 generation을 전달합니다. 오래된 remove는 Sidecar를 한 번도 호출하지 않습니다.
Core가 이 service를 pin한 뒤 Kitty는 다른 tab 왕복 후에도 42×30 surface와 shell output을 유지했고,
같은 OSC set/reset 상태 및 pixel 검증도 통과했습니다.

Ghostty는 engine 결함이 아니라 readiness 측정 결함을 드러냈습니다. `waitForText`가 첫 성공한 native
state event 전에 surface를 읽었습니다. Vision 0.0.14는 이 event 뒤에만 read합니다. 그 다음 VT100은
같은 input gate 부재를 드러냈습니다. 즉시 입력이 service가 session 25를 공개하기 전에 opening
session의 zero value에 도달했습니다. Vision 0.0.15는 같은 event까지 입력을 보관하고 정확히 한 번
전달하며, 준비 전 dispose는 보관 입력을 명시적으로 거부합니다. 두 event gate 적용 뒤 Ghostty·VT100·
WezTerm은 tab 왕복 뒤에도 42×30 grid와 cursor를 유지했고 marker 순서로 보장한 OSC set/reset 및 직접
pixel 확인을 통과했습니다. Reset sequence 뒤 marker를 출력해야 하며 shell의 명령 echo는 실행
barrier로 인정하지 않습니다.

Xterm.js 6.0.0에는 effective color 공개면이 없었습니다. `options.theme`은 host base이고 OSC가 바꾼
`ThemeService.colors`는 private였습니다. `_core`를 읽으면 Plugin이 내부 object graph에 결합하므로
Xterm renderer가 read-only `effectiveTheme` snapshot을 공개합니다. OSC color parse·apply·
reset은 계속 engine이 소유합니다. Renderer는 host base theme 변경 중 active OSC override를 유지하고 reset
뒤 새 base를 드러냅니다. Owner gate는 unit test 2,324개, API lint, 실제 Chrome set/reset을 통과했습니다.
Renderer는 `@soksak/xterm@6.0.0`으로 build·Registry publish되고 `@xterm/xterm` npm alias로 소비합니다.
Consumer Git prepare·codeload locator·private API 접근은 없습니다. Xterm Plugin 0.0.54는 native provider와
같은 runtime state, dark→light, reset, tab switch, pixel 검증을 통과했습니다.

## Pointer reporting 행 — 2026-08-29

| Provider | Engine API | Owner byte | 설치 PTY | Pixel | 판정 |
| --- | --- | --- | --- | --- | --- |
| Alacritty 0.0.37 | `alacritty_terminal` mode와 provider encoder | SGR press/drag/release/free-motion, legacy modifier와 release | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| Ghostty 0.0.34 | provider `GhosttyMouseEncoder`와 `GhosttyMouseEvent` | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| Kitty 0.0.31 | provider ABI를 통한 Kitty `Screen` mouse encoder | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| Shitty 0.0.30 | provider ABI를 통한 Shitty `encodeMouseProtocol` | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| VT100 0.0.33 | provider `Screen::encode_mouse_event` | SGR press/drag/release/free-motion, legacy, UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| WezTerm 0.0.33 | 기존 `TerminalState::mouse_event`와 동기 raw writer tap | SGR press/drag/release/free-motion, legacy, UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |

Ghostty는 terminal mouse encoder를 복사하지 않습니다. Owner는 engine encoder 하나와 재사용 event를
유지하고 live `GhosttyTerminal`에서 mode와 format을 갱신한 뒤 action, button, modifier, position을
provider C API에 전달합니다. v7 불변 release digest는 Ghostty
`ed39380c51cdd09ae499d56b728b8c09aa1b24f975eb7f4db8ae8a11ed961225`, Vision
`f38eed4cfcf2c55b33e724490fe928a80b0791c850f8bf634d7f00b597dc3ed3`, Xterm
`d863e11c3c253d53f780be9c11d1d9655b14a03e006f7392e2453ebe7120a601`입니다. Batch plan
`f81c5f078add204e2093fd60a73aedda9a754bc36d0df49888e3d50e1bbf0b66`은 component 아홉 개를
environment revision 55로 설치했습니다. 설치한 Ghostty pane에서 1002+1006 down/drag/up은
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`, route `mouse-report`, sequence 3,
마지막 write count 9를 만들었습니다. 536,524-byte 합성 snapshot에서 echo된 sequence, 결과 hex,
prompt, cursor를 직접 확인했고 capture 전후 모두 `windowFocused=false`였습니다.

이 행은 Ghostty selection이나 wheel을 인증하지 않습니다. 두 engine API는 명시적인 owner refusal로
남아 있으며 열린 selection/scroll matrix에 포함됩니다.

Kitty도 같은 ownership 규칙을 따릅니다. Provider revision
`9df1e0b7c5b93e933e877c36ee45ae62935c9b48`은 기존 live `Screen` mouse encoder를
`kitty_provider_pointer`로 공개합니다. Sidecar는 정규화된 사실만 전달하며 protocol encoder를 담지
않습니다. v7 불변 release digest는 Kitty
`3954fe6fcfd63dc7afa1bea2305c46d19b2a119d61cfec4276c195724791614b`, Vision
`ace05568fafeecb34725ab40cc57c2d32e9b42e1bd810776c107f2dae0c0e828`, Xterm
`d259f19c31b4051fd04cddcee1dcde47aa3fce8eb886998a8d119124922470ce`입니다. Batch plan
`d6d0d0932045151281e926a2da85852dc83546e7a42a4606a526e2a0457feed4`은 component 아홉 개를
environment revision 57로 설치했습니다. 설치한 Kitty pane은 앞 행과 같은 exact down/drag/up hex,
route, sequence, 마지막 write count를 만들었습니다. 289,925-byte 합성 snapshot에서 결과, prompt,
cursor를 직접 확인했고 `windowFocused=false`는 바뀌지 않았습니다. Kitty selection과 wheel은 열려
있습니다.

Shitty도 같은 engine-owner 계약을 따릅니다. Provider revision
`dbc42af98907fadd5b057d2922b890b2725c016c`은 기존 live `encodeMouseProtocol` 경로를
`soksak_shitty_terminal_pointer`로 공개합니다. Sidecar는 정규화된 사실을 이 ABI로 전달하며 terminal
protocol encoder를 담지 않습니다. v7 불변 release digest는 Shitty
`01c6621658afe703d2e17e14f77117753b850ff49142e615eba326615d2ee925`, Vision
`55dc94b7a14763405d4c974d011fe427a64cf54761d8d7c26e00a3cdc3f5f3bd`, Xterm
`c5626b60fb0af8933de2d50fbbc893921786810f1c93a16e49b9bc091e8b30af`입니다. Batch plan
`d8d9b1f8fe46864028b68af1b4079c799ccd6b51319576f116b8eda717b08fc2`은 component 아홉 개를
environment revision 59로 설치했습니다. `tab-espq62.1`에서 공개 `ui.input.drag` transaction 하나가
pointer sequence 3과 shell hex
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`를 만들었고 앞 provider 행과 정확히
같았습니다. 138,685-byte 합성 snapshot에서 결과, prompt, block cursor를 직접 확인했으며 capture
전후 `windowFocused=false`는 바뀌지 않았습니다. Shitty selection과 wheel은 열려 있습니다.

첫 설치 시도는 exact selection 결함을 드러냈습니다. Generic sidecar resolver가 `environment.json`에서
선택한 process 경로는 읽었지만 version을 버려 0.0.30 binary를 `version:null`로 시작했습니다. 이후 exact
0.0.30 선택이 그 process를 교체했고 held surface에는 renderer가 남지 않았습니다. Core commit
`fc20078`과 `058e453`은 process-generation event를 공개하고 held declaration을 다시 엽니다. Commit
`9028c0b`과 `b52da36`은 path-only resolver를 제거하고 이름 해석이 `{name, version, path}`를 하나의
선택으로 반환하게 합니다. Core 전체 검증은 321 files, 2,333 tests를 통과했습니다. Core `9a2a61c`로
다시 빌드한 v7에서 Shitty process record는 처음부터 version 0.0.30, PID 39484였고 그대로 유지됐습니다.
`tab-nljljd.1`은 같은 exact pointer hex와 sequence 3을 다시 만들었습니다. 156,257-byte 합성 snapshot은
결과, prompt, block cursor를 유지했고 전후 `windowFocused=false`였습니다. 불필요한 process 교체는
제거됐습니다. Generation-reopen 보완은 owner test를 통과했으며 이 결과가 임의의 multi-pane process
교체에 대한 runtime 인증은 아닙니다.

VT100은 protocol 구현을 provider에 둡니다. Provider revision
`c5cc944741d422f94ef898d7efe79edff609feb2`은 parser의 live mode와 encoding을 읽는
`Screen::encode_mouse_event`를 추가합니다. Sidecar는 정규화된 사실만 전달하며 mouse encoder를 담지
않습니다. v7 불변 release digest는 VT100
`318f1024cb0fd481d7bf96203657e0fc6a2f42802fb9b24aedd334db26d0ad89`, Vision
`e3bc1b2101ba3e3d6e7c51d873a7100523e2e799b5154fc38e8097c38962b7b4`, Xterm
`0ef0422a179d423c240c346fc815c3d16f3d0ee923d6cbcd98d591a728393d1e`입니다. Batch plan
`f175d07742fd7aa31e48bed2bcb4b85a1c43c1b7457637e3f866445c87eda833`은 component 아홉 개를
environment revision 62로 설치했습니다. Exact VT100 0.0.33 process PID 63849가
`tab-3yhreg.1`을 처리했고 공개 drag 하나가 pointer sequence 3과 shell hex
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`를 만들었습니다. 140,613-byte 합성
snapshot에서 결과, prompt, block cursor를 확인했고 전후 `windowFocused=false`였습니다. VT100
selection과 wheel은 열려 있습니다. 첫 live-install 시작은 process를 만들지 못하고 shutdown을
막았으며 clean application boot 뒤 exact 0.0.33이 시작됐습니다. Hot-install startup은 OPEN이며 이
pointer 행으로 인증하지 않습니다.

WezTerm에는 provider 변경이 필요하지 않았습니다. 기존 `TerminalState::mouse_event`가 live mode, button
state, SGR, UTF-8, legacy encoding을 소유합니다. Sidecar는 정규화된 `MouseEvent`를 전달하고 그 동기
호출이 만든 raw writer byte만 읽습니다. v7 불변 release digest는 WezTerm
`aa67ee9711b82d2507dc30572e7300d91db667dcdb5cfc50c9414c3ae869147f`, Vision
`b8cabda9238208c40eea572d990eeeea3de79321f124c393e25dda4d2c296cf2`, Xterm
`2092a6fd0ac246377aec003d6ebcddfc1628fc6c6e2b180e6ec2d51ef710d7d4`입니다. Batch plan
`ae464754b166f2acdc01dc42044419d53365cf2596667cd2794f0c012ed765ac`은 component 아홉 개를
environment revision 65로 설치했습니다. Exact WezTerm 0.0.33 process PID 83318이
`tab-r64m3b.1`을 처리했고 공개 drag 하나가 pointer sequence 3과 shell hex
`1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`를 만들었습니다. 143,836-byte 합성
snapshot에서 결과, prompt, block cursor를 확인했고 전후 `windowFocused=false`였습니다. WezTerm
selection과 wheel은 열려 있습니다. Native pointer 여섯 행은 모두 GREEN이며 남은 terminal-standard
행을 인증하지는 않습니다.

## 남은 행

Cursor, CSI/OSC/DCS/APC 범위, bracketed paste, mouse mode, drag selection, copy, wheel/trackpad scroll,
file/image drop, clipboard image, Kitty graphics, iTerm2 OSC 1337, Sixel, TUI host split, latency, damage,
gap gate는 각 matrix 실행 전까지 UNVERIFIED입니다.

## Selection, copy, scroll 상태 — 2026-08-30

선택된 renderer가 selection text와 scrollback 위치를 소유합니다. Core는 하나의 일관된 pointer
transaction을 제공합니다. Down은 primary-button detail을, move는 held buttons를 포함하며 move/up event는
source document를 통과합니다. Kit은 renderer가 보고한 selection과 scroll 상태를 그대로 게시합니다.
Copy는 허가된 host clipboard에 selection을 쓰며 독립 clipboard read가 같은 text를 반환해야 합니다.

설치된 xterm Plugin 0.0.69는 자기 행의 selection, copy, 기본 scroll을 통과했습니다.

- 공개 drag가 `SELECT_ME_1234567890`의 정확한 20자 selection을 반환하고 선택 범위를 그렸습니다.
- `copy`와 독립 `clipboard.read`가 같은 20자를 반환했습니다.
- 80행 출력 뒤 `scroll(lines=10)`과 status가 모두 `{historySize:85, offset:10}`을 반환했습니다.
- scroll viewport는 `64..71`을 읽었고 `scroll(edge=bottom)`은 offset 0을 반환했습니다.

Status의 follow/pinned 상태, wheel의 local-scroll/PTy 단일 route, mouse-reporting 충돌, 설치된 모든 provider의
같은 drag/copy/scroll 검사가 끝날 때까지 전체 matrix는 RED입니다. Command 이름, source 존재, screenshot
하나만으로는 통과가 아닙니다.

## Native selection·scroll matrix — 2026-08-30

Vision 0.0.35는 Contract 0.0.19, Plugin Kit 0.0.94, Sidecar Kit 0.0.30으로 만든 Sidecar 6개를
소비합니다. 각 owner가 release를 attest했고 local store는 `published` 뒤 `unchanged`를 반환했습니다.
renderer reload에서 stale compositor sequence가 드러났으며 compositor commit `5fe697e`는 거부 응답의
backend sequence floor를 채택하고 현재 full inventory를 재선언합니다. 설치 runtime hot reload는
composition sequence 18→38, surface 7개, `worst=0`, unapplied/undeclared 0을 보고했습니다.

첫 native drag는 `focused` 값 누락을 드러냈습니다. Vision 0.0.33은 input을 focus한 뒤 정확한
`surface.focus {focused:true}` transaction을 기다리고 pointer를 전달합니다. Alacritty는 이후
`SELECT_ALACRITTY_1234567890`을 선택했고 selection, copy, 독립 clipboard read가 같은 27자를 반환했으며
capture에서 engine 소유 선택 범위를 직접 확인했습니다.

Native scroll은 두 공통 결함을 드러냈습니다. Vision은 비동기 surface 응답 전에 반환했고 Sidecar Kit은
양수 lines를 bottom 방향으로 해석했습니다. Plugin Kit 0.0.94는 remote scroll 완료를 기다리고,
Vision 0.0.34는 적용 응답을 반환하며, Sidecar Kit 0.0.30은 양수를 history, 음수를 bottom으로
정의합니다. Fresh 설치 row 결과는 다음과 같습니다.

| Provider | Selection | `scroll(lines=10)` | Status/read/pixel | 판정 |
| --- | --- | --- | --- | --- |
| Alacritty 0.0.39 | 최종 closure RED: fresh pane 두 개에서 PTY output은 전진했지만 canonical frame run이 전부 비어 있음 | RED/unknown | cursor/selection overlay만 있는 빈 surface | provider RED |
| Ghostty 0.0.37 | 정확한 `SELECT_GHOSTTY_24680`; copy와 독립 clipboard read가 20자로 일치 | `10/52/pinned` | `GROW042..071`, selection·scroll pixel 확인 | selection/copy/scroll GREEN |
| Kitty 0.0.34 | 정확한 `SELECT_KITTY_24680`; copy와 독립 clipboard read가 18자로 일치 | `10/54/pinned` | `KROW042..071`, selection·scroll pixel 확인 | selection/copy/scroll GREEN |
| Shitty 0.0.33 | 정확한 `SELECT_SHITTY_24680`; copy와 독립 clipboard read가 19자로 일치 | `10/54/pinned` | `SROW042..071`, selection·scroll pixel 확인 | selection/copy/scroll GREEN |
| VT100 0.0.36 | 정확한 `SELECT_VT100_1234567890`; copy와 독립 clipboard read가 23자로 일치 | `10/54/pinned` | selection pixel 확인, scroll command/status 일치 | selection/copy GREEN, scroll 상태 GREEN·viewport regression OPEN |
| WezTerm 0.0.36 | 정확한 `SELECT_WEZTERM_24680`; copy와 독립 clipboard read가 20자로 일치 | `10/136/pinned` | `WZROW042..071`, selection·scroll pixel 확인 | selection/copy/scroll GREEN |

최초 GREEN인 scroll 5개 row는 command와 status에서 같은 offset·`followMode`를 반환했고 capture
viewport는 42~71행을 보였습니다. VT100 selection은 provider revision `d557ec1`이 viewport를 움직이지 않는
signed logical-row text API를 노출하고 Sidecar 0.0.36이 selection endpoint·range를 소유하면서 GREEN이
됐습니다. 이후 80행 실행은 `10/54/pinned`를 반환했지만 viewport pixel이 비어 있어 scroll pixel row는
OPEN입니다. native selection 여섯 행은 GREEN입니다. 현재 Alacritty closure 판정 전에 frame regression을
해결해야 합니다.

Ghostty Sidecar 0.0.37은 libghostty-vt selection gesture, terminal-owned tracked selection, selection
formatting, native containment를 사용합니다. Kitty Sidecar 0.0.34는 선택된 Kitty provider의 `Screen` selection
mode, text, row-range method를 provider SDK를 통해 사용합니다. Shitty Sidecar 0.0.33은 선택된 Vterm과
Screen의 logical row selection surface를 history까지 사용합니다. 각 owner RED는 명시적인 unimplemented
refusal에서 먼저 실패했습니다. 같은 owner gate가 이제 simple, semantic, line, extend 동작을 검증하며
세 provider 모두 generic Kit range를 대신 사용하지 않습니다.

Vision 0.0.49는 해당 exact release를 선택합니다. 설치 제품의 공개 DOM drag, selection command, copy
command, 독립 clipboard read가 표의 marker 길이와 일치했습니다. focus-free capture에서 각 engine-owned
selection을 확인했습니다. 같은 exact process가 번호 row 80개를 만든 뒤 scroll command와 공개 status는
`offset=10/pinned`로 일치했고 Plugin read와 세 합성 native capture는 모두 42~71행을 보여 줬습니다.
불변 local release digest는 Ghostty
`58cebbd9ed083e5aa53ed3697dcc332c0bc0a7c7ebfef9fed6689d3acd0a64bd`, Kitty
`255447965971867b0f62d382ccefa3d40031b2c6de4ba410eb95eb7f2cf43c85`, Shitty
`884679ae72e877e674b95df9371b1dde6504fb41236ae1fb0ffe638f6b0f58d6`, Vision 0.0.49
`2a7be50dfab36ae3db06bbfe7acb2bb9b503f6c7280194e8ce23a54dde1acdd0`입니다.

WezTerm Sidecar 0.0.36은 선택된 engine이 materialize한 row 위에서 simple, line, block, extend selection을
소유합니다. owner RED는 provider가 selection을 반환하지 않아 먼저 실패했고, 같은 이름의 test가 이제
generic Kit fallback 없이 정확한 text와 row range를 반환합니다. Vision 0.0.46은 그 불변 Sidecar를
선택합니다. 설치된 capture-only environment에서 공개 DOM drag는 `SELECT_WEZTERM_24680`을 선택했고,
selection command, copy command, 독립 clipboard read가 같은 20자를 반환했습니다. window가 non-key인
상태에서 native selection pixel을 직접 확인했습니다. 같은 process가 이어서 번호 row 80개를 만들었고,
`scroll(lines=10)`은 `10/136/pinned`, Plugin read는 42~71행을 반환했으며 합성 native capture도 해당 row를
보여 줬습니다. drag, copy, capture, scroll 전후 Sidecar PID는 바뀌지 않았습니다.

## 최초 output 증거 — 2026-08-30

PTY Sidecar 0.0.20은 기존 output ring에서 bounded `pty.tail` 증거를 노출합니다. 응답은 retained floor,
through sequence, 반환 byte 수, base64 byte를 밝히며 private runtime file을 읽거나 두 번째 output owner를
만들지 않습니다. Sidecar Kit 0.0.31은 consumer가 실제로 받은 byte도 `terminal.status`로 게시합니다.
기존 event·output sequence와 함께 누적 관측 output byte 수, 마지막 observation의 source range, byte 수,
SHA-256을 게시합니다.

기존 Alacritty RED의 원인은 다음 두 관측 사이로 좁혀졌습니다. PTY ring은 shell prompt가 든 401 byte를 보존했지만,
같은 pane의 첫 full `terminal.frame`은 output sequence 401과 비어 있는 30개 row를 반환했습니다. 관측된
control-sequence 형태를 Alacritty owner에 직접 feed하면 shrink-expand resize를 거쳐도 prompt가 남았습니다.
같은 pane에 나중에 보낸 command는 정상 렌더됐습니다. 따라서 이 결함은 간헐적인 최초 lifecycle 또는
delivery 실패이며 engine이 prompt를 parse하지 못한다는 증거나 compositor paint 결함이 아닙니다.

깨끗한 Vision 0.0.38 closure는 PTY 0.0.20과 Alacritty 0.0.40을 선택했습니다. Fresh pane 세 개가 각각
관측 byte 401, gap 0, 일치하는 마지막 observation range, prompt가 든 full frame을 반환했습니다. 각 pane은
tab activation 뒤 서로 다른 marker를 받았습니다. 측정한 tab switch 세 경로는 모두 한 clean frame이며
flicker, blank, overlap, native receipt mismatch가 0이었습니다. 앱 재시작 뒤에도 세 exact session의 marker와
prompt가 유지됐습니다. 두 composed capture는 모두 non-key 상태를 유지했고 직접 확인했습니다.

Alacritty 최초 output은 계속 OPEN입니다. 0.0.40은 증거와 owner guard만 추가했으며 동작 변경이 없으므로
한 번의 clean run으로 이전 RED를 지울 수 없습니다. 동일한 scheduling 순서에서 빈 최초 full frame을
결정적으로 재현하고 GREEN으로 바꾸는 이름 있는 lifecycle test가 있어야 완료됩니다.

VT100 0.0.37은 같은 observable Sidecar Kit을 사용하며 shifted viewport의 80행 burst owner guard를
추가했습니다. 깨끗하게 설치한 Vision 0.0.39 실행에서 terminal은 source byte 1,368개를 gap 0으로
소비했고 `scroll(lines=10)`은 `10/52/pinned`를 반환했습니다. Full provider frame은 42~71행,
Plugin read는 43~71행을 포함했고 non-key composed capture에서도 그 행을 확인했습니다. 이는 clean-run
scroll row의 GREEN이며, 동일한 실행 순서를 결정적으로 재현하기 전까지 이전 blank lifecycle 관측은 유효합니다.

같은 실행은 truthful-label 결함도 드러냈습니다. VT100 pane의 command가 `alacritty terminal
read/scroll`로 보고됐습니다. Plugin Kit 0.0.95는 static command description을 default engine이 아니라
terminal Plugin label에서 만듭니다. Vision 0.0.40은 public status의 `engineId=vt100`을 유지하면서
`Vision Terminal read/scroll`을 반환했습니다. 이 hot Plugin replacement 직후 첫
`scroll(offset=10)`은 offset 0을 반환했고, 다음 `scroll(lines=10)`은 `10/52/pinned`를 반환하고
게시했습니다. 따라서 hot-reload scroll readiness는 OPEN이며 clean-run row에 포함하지 않습니다.

## Native remount 소유권 — 2026-08-30

Hot-reload scroll RED에는 서로 독립적인 원인 네 개가 있었고 각 owner에서 수정했습니다.

- Plugin Kit이 아직 history를 게시하지 않은 renderer의 0을 상한으로 absolute offset을 잘랐습니다.
  Kit 0.0.96은 음수가 아닌 absolute request를 authoritative clamp owner인 renderer에 그대로 보냅니다.
- Mount된 Plugin view가 container generation을 공개하지 않았습니다. Core는 public view context에 이를
  게시하고 Kit 0.0.97은 renderer까지 전달합니다.
- Surface pane이 mount 즉시 live로 보고됐습니다. Kit 0.0.98은 surface presenter의 generation-owned
  `ready` promise를 기다리며 timer나 polling loop를 사용하지 않습니다.
- Vision의 이전 presenter가 공용 surface id를 통해 `surface.stop`을 보냈습니다. 이는 두 번째 lifetime
  writer였고 remount 뒤 새 generation을 중지할 수 있었습니다. Vision 0.0.45는 presenter dispose에서
  stop을 보내지 않으며 compositor declaration removal만 teardown을 소유합니다.

Terminal-surface service는 declaration generation과 내부 lifecycle generation을 분리합니다. State와
Plugin event는 declaration generation을 전달하고 stale remove 방지는 lifecycle generation을 사용합니다.
`terminal_surface_status`는 두 값을 모두 게시하고 blocked generation의 정확한 error를 보존하며,
still-live owner보다 새 replacement가 실패한 경우도 함께 게시합니다. Start 성공은 generation이 든 lifecycle
state event를 한 번 발행하므로 remount presenter가 무관한 다음 output frame을 기다리지 않습니다.

설치한 VT100 실행에서 앱 복원은 declaration generation 2/lifecycle 1로 live가 됐습니다. 같은 version의
disable→enable 뒤에는 declaration generation 14/lifecycle 5로 live를 유지했고 첫 `scroll(offset=10)`이
`10/52/pinned`를 반환했습니다. Plugin read는 43~71행을 반환했습니다. Composed capture는 42~71행을
실제로 보였고 전후 `windowFocused=false`를 유지했습니다. Hot-remount scroll readiness row는 GREEN입니다.

## 입력 시 selection 종료 — 2026-08-30

설치된 Vision 0.0.50에서 `COPY_BACKSPACE_ABCDE`와 `한글복사테스트`를 각각 선택·복사·붙여넣고
노출된 terminal input node로 Backspace를 보냈습니다. Alacritty engine frame은 ASCII 마지막 글자와
폭 2인 한글 마지막 cell을 정확히 제거했지만, paste와 Backspace 뒤에도 `selection`은 복사한 text를
그대로 반환했습니다. 따라서 재현된 화면 훼손은 남아 있던 engine-owned selection overlay였고
Backspace parser나 실제 grid가 훼손된 것은 아니었습니다.

Vision 0.0.51은 활성 selection이 있으면 첫 confirmed `surface.input`보다 먼저
`surface.selection {action:"clear"}`를 직렬화합니다. 이름 있는 presenter RED는 `surface.input`만
관측했고 같은 테스트의 GREEN은 정확히 `selection clear -> input` transaction을 관측합니다. Owner
전체 gate는 32개 테스트를 통과했습니다. Immutable local release는 `published` 뒤 `unchanged`였고
digest는 `da557123859ee681f4de27c4d59098a10c3e3f8c75c113a0df585ac34638fec8`입니다.

설치된 capture-only 환경은 8개 component local closure로 Vision 0.0.51을 선택했습니다. 같은 한글
복사·붙여넣기 뒤 `selection`은 Backspace 전에 빈 문자열을 반환했습니다. Backspace는 마지막 한글
cell만 제거했고 선택했던 output row에는 overlay가 남지 않았습니다. 전후 composed capture를 직접
확인했으며 두 capture 모두 `windowFocused=false`였습니다.

## Prepared observer retained prefix — 2026-08-30

PTY 0.0.21은 실행 중 session pump에 prepared observer를 연결하는 동작을 원자화합니다. Opened frame이 retained
floor를 알리고 retained prefix가 뒤따른 다음에만 live output이 올 수 있습니다. 결정적 owner RED는
보존된 prompt를 잃었고 GREEN은 다음 live bytes보다 먼저 같은 bytes를 받습니다. 설치 앱 재시작에서
보존된 PTY는 401 bytes를 보고했고 새 Alacritty session도 같은 401 observed bytes, `0..401` range,
SHA-256과 prompt가 든 full frame을 보고했습니다. Retained-prefix 전달 자체는 이 증거로 닫힙니다.

같은 restart capture는 별개의 size-ordering 결함도 드러냈습니다. Shell이 surface의 실측 126-column
resize보다 먼저 기본 80 column에서 첫 prompt를 출력해, observer 연결 뒤 prompt가 80번째 column에 남았습니다.
Surface Contract 0.0.9는 side effect가 없는 `surface.measure`를 정의하고 Sidecar Kit 0.0.32는
`surface.open`과 같은 renderer font metrics로 이를 구현합니다. terminal-surface service `b2d591b`는
새 pane을 `measure -> observer 준비 -> PTY open -> engine 구독 -> surface open` 순서로 시작합니다.
실측 grid를 모든 process-facing 단계에 그대로 전달하며 `surface.open`이 다른 grid를 답하면 거부합니다.

Vision 0.0.52는 Alacritty Sidecar 0.0.41을 선택합니다. Sidecar immutable release digest는
`15be80bb6b199856446cbf2ea94bccd8acf4c991c5dba9b3c0825b6185adaba4`, Vision digest는
`2ebf654acc771ccc1ae12049339a50fdb08b8f7f259fa3121f28004daa7c89f6`입니다. 새 격리 설치 제품에서
pane 세 개가 각각 PTY, engine, surface grid `126x30`, observed bytes 352, gap 0을 보고했고 첫 non-empty
row는 모두 row 0, cursor는 `[0,14]`였습니다. 이전 80-column padding은 어느 row에도 없었습니다.
Composed capture에서 prompt가 왼쪽에 그려졌고 전후 `windowFocused=false`였습니다. Alacritty row의
initial-size ordering은 GREEN이며 다른 provider는 같은 Kit을 소비한 뒤 각 row에서 다시 판정합니다.
