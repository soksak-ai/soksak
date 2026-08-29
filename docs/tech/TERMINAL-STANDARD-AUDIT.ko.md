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
| Xterm.js 6.0.0 fork | 59×29 live, 다른 tab 왕복 뒤 39×29 | `#123456/#234567/#345678`, ANSI 1 `#456789` 정확히 일치 | GREEN; 현재 light base 복원 | GREEN | 이 행 GREEN |

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
`min-median-max/xterm.js` fork가 read-only `effectiveTheme` snapshot을 공개합니다. OSC color parse·apply·
reset은 계속 engine이 소유합니다. Fork는 host base theme 변경 중 active OSC override를 유지하고 reset
뒤 새 base를 드러냅니다. Owner gate는 unit test 2,324개, API lint, 실제 Chrome set/reset을 통과했습니다.
Fork는 `@soksak/xterm@6.0.0`으로 build·Registry publish되고 `@xterm/xterm` npm alias로 소비합니다.
Consumer Git prepare·codeload locator·private API 접근은 없습니다. Xterm Plugin 0.0.54는 native provider와
같은 runtime state, dark→light, reset, tab switch, pixel 검증을 통과했습니다.

## Pointer reporting 행 — 2026-08-29

| Provider | Engine API | Owner byte | 설치 PTY | Pixel | 판정 |
| --- | --- | --- | --- | --- | --- |
| Alacritty 0.0.37 | `alacritty_terminal` mode와 provider encoder | SGR press/drag/release/free-motion, legacy modifier와 release | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| Ghostty 0.0.34 | fork된 libghostty-vt `GhosttyMouseEncoder`와 `GhosttyMouseEvent` | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| Kitty 0.0.31 | provider ABI를 통한 fork된 Kitty `Screen` mouse encoder | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| Shitty 0.0.30 | provider ABI를 통한 fork된 Shitty `encodeMouseProtocol` | SGR press/drag/release/free-motion | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| VT100 0.0.33 | fork된 vt100-rust live `Screen::encode_mouse_event` | SGR press/drag/release/free-motion, legacy, UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |
| WezTerm 0.0.33 | 기존 `TerminalState::mouse_event`와 동기 raw writer tap | SGR press/drag/release/free-motion, legacy, UTF-8 | exact down/drag/up hex, sequence 3 | GREEN | 이 행 GREEN |

Ghostty는 terminal mouse encoder를 복사하지 않습니다. Owner는 engine encoder 하나와 재사용 event를
유지하고 live `GhosttyTerminal`에서 mode와 format을 갱신한 뒤 action, button, modifier, position을
fork C API에 전달합니다. v7 불변 release digest는 Ghostty
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

Kitty도 같은 ownership 규칙을 따릅니다. Fork commit
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

Shitty도 같은 engine-owner 계약을 따릅니다. Fork commit
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

VT100은 protocol 구현을 engine fork에 둡니다. Fork commit
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

WezTerm에는 fork 변경이 필요하지 않았습니다. 기존 `TerminalState::mouse_event`가 live mode, button
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

## Selection, copy, scroll RED 기준선 — 2026-08-29

표준은 직접 만든 selection algorithm이 아닙니다. Xterm.js 6은 `onSelectionChange`, `getSelection`,
`getSelectionPosition`, `hasSelection`, `onScroll`, `scrollLines`, `scrollPages`, 절대 scroll method를
제공합니다. Xterm mouse mode는 X10, VT200, button-event, any-event tracking을 구분합니다. Local
selection은 application이 잡은 mouse를 빼앗지 않으며 명시적인 강제-selection modifier는 terminal
policy로 둡니다. OSC 52 application clipboard I/O는 사람이 cell을 선택하고 host copy command를
호출하는 것과 별도입니다.

현재 소스는 unsupported가 아니라 RED입니다.

- Xterm은 selection과 scroll을 engine API에 위임합니다.
- 공유 DOM frame presenter는 왼쪽 `mousedown`에서 `preventDefault()`를 호출한 뒤 browser document의
  selection을 읽습니다. 이 시작 event가 나중에 읽으려는 selection 자체를 막습니다.
- Vision은 `surface.selection`을 비동기로 보내지만 reply 전에 cache text를 반환합니다. Terminal Kit
  0.0.78이 async presenter interface를 세웠고 Vision owner test가 이전 stale-empty 결과를 증명합니다.
- Native render runtime은 `surface.selection`을 `NOT_YET_SERVED`로 명시적으로 거부하며 selection
  overlay를 그리지 않습니다. Native host view는 hit test를 통과시키지만 Plugin container는 현재
  gesture를 hidden input focus에만 사용합니다.
- Native `surface.scroll`은 이미 mirror viewport를 바꾸고 `{offset, historySize}`를 반환합니다. Vision은
  reply를 버리고 ACK 전에 local offset을 바꾸며 wheel gesture를 등록하지 않습니다. Surface state에는
  wheel·drag가 local viewport 동작인지 PTY mouse input인지 결정할 engine mouse/alternate-scroll mode도
  없습니다.

Provider 소스에는 유지되는 selection 기계가 이미 있습니다. Alacritty는 `Selection`/`SelectionType`과
`Term::selection_to_string`을, Ghostty VT API는 selection gesture와 row selection range를, Kitty Screen은
start/update/text selection 연산과 selection render data를 제공합니다. Provider source owner가 자기
저장소에서 해당 API를 adapter로 연결해야 합니다. Core나 Plugin code의 generic cell-string fallback은
금지합니다.

수직 GREEN 순서는 다음으로 고정합니다.

1. async selection reply가 exact string 하나 또는 이름 있는 거부 하나로 Kit `selection`, `copy`, status,
   DOM data, event에 도달합니다.
2. provider 구현 전에 terminal sidecar contract가 gesture kind, cell point/side, phase, modifier, 반환
   selection snapshot을 정의합니다.
3. provider 하나가 engine selection API로 simple drag를 처리하고 engine selection range를 그립니다.
4. wheel scroll은 engine receipt를 await하고 offset/history/follow 상태를 게시합니다.
5. mouse tracking과 alternate-scroll mode는 modifier 없는 gesture를 PTY로 보내고 명시적인 modifier를
   local selection으로 보냅니다.
6. 남은 provider가 같은 계약을 자기 저장소에서 구현한 뒤 설치된 일곱 provider matrix가 실제 drag,
   selection read, copy, wheel, mode-conflict gate를 실행합니다.

Command 존재, source 존재, screenshot만으로는 이 행을 GREEN으로 만들 수 없습니다.
