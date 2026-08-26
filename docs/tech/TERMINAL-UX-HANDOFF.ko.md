---
kind: translation
status: active
canonical: docs/tech/TERMINAL-UX-HANDOFF.md
scope: workspace
---

# 터미널 UX 결함 인계

이 문서는 2026-08-25 현재 제보된 열 결함, 현재 증거, 남은 release 구분를 기록합니다. 필수 실행
순서와 증거는 TERMINAL-UX-EXECUTION.ko.md에 정의합니다. Local candidate GREEN을 immutable
release 또는 실행하지 않은 native-platform GREEN으로 확대해서는 안 됩니다.

## 제보된 결함

열 항목 모두 인수 조건입니다. 특정 provider나 특정 발생 조건만 고친 결과는 미완료입니다.

1. Xterm 이외의 모든 터미널이 느립니다.
2. Xterm 이외의 모든 터미널이 포커스를 받지 못합니다.
3. Xterm 이외의 모든 터미널에서 입력 커서가 활성화되지 않습니다.
4. Xterm 이외의 모든 터미널에서 키보드 입력이 되지 않습니다.
5. 탭 plus 선택 창을 열면 닫을 때까지 각 탭 화면이 사라집니다.
6. 설정이나 다른 모달을 열면 닫을 때까지 각 탭 화면이 사라집니다.
7. 사이드바가 이동하는 동안 각 탭 화면이 사라집니다.
8. 같은 터미널 킷을 사용하지만 Xterm과 다른 터미널의 색상이 다릅니다.
9. macOS 신호등 닫기 버튼으로 창을 닫을 수 없습니다.
10. 테스트가 보이는 앱 창을 반복해서 열고 닫아 사용자 작업을 방해합니다.

## Workspace 지도

개발 workspace root는 ~/soksak/wails3beta입니다. 아래 component directory에는 독립된
repository가 들어 있습니다. Workspace 배치는 runtime 탐색 수단이 아니며 설치 component는
environment.json에서 확인합니다.

| Workspace root 기준 path | 책임 |
| --- | --- |
| soksak-core/ | 현재 Wails application, control CLI, renderer, framework adapter, application lifecycle, Core gate. 이 인계 문서의 소유 repository입니다. |
| soksak-plugins/ | 설치 가능한 plugin별 repository. 일곱 terminal provider repository가 있습니다. |
| soksak-kits/ | 공유 component 구현. soksak-kit-plugin-terminal은 공통 terminal lifecycle과 frame presenter를, soksak-kit-sidecar-terminal은 recovery-sidecar runtime을 소유합니다. 예전 terminal-common과 engine-as-judge conformance repository는 consumer가 없으며 폐기 대상입니다. |
| soksak-sidecars/ | Plugin process별 repository. PTY 및 여섯 frame-producing terminal sidecar가 있습니다. |
| soksak-contracts/ | Composition, control, PTY, registry, terminal 구분의 공개 contract와 acceptance package입니다. |
| soksak-specs/ | 공개 schema와 validator의 정본입니다. 공개 state 또는 command 모양을 바꾸면 consumer보다 먼저 수정합니다. |
| soksak-plugin-registry/ | 공개된 plugin release 참조입니다. 구현과 release 이후 metadata를 받으며 terminal 동작을 소유하지 않습니다. |
| wails-services/ | Wails host service입니다. Native compositor와 webview surface 책임이 있습니다. |
| forks/ | 직접 유지하는 upstream fork입니다. `origin`은 소유 fork, `upstream`은 원본이며 유지 branch가 upstream version을 이름에 포함합니다. Product build는 이 path가 아니라 공개 repository와 exact commit을 사용합니다. |
| libraries/ | xterm-addon-webkit-ime처럼 직접 만든 재사용 library입니다. Upstream fork가 아닙니다. |
| externals/ | 수정하지 않는 제3자 비교 source입니다. |
| tests/ | 제품 전용 system 및 acceptance repository입니다. |
| local/ | 개발 전용 고정 runtime, source checkout, test input, work state입니다. Product code와 test가 dependency를 여기서 탐색하면 안 됩니다. |
| evidence/ | 생성된 screenshot과 recording입니다. Product source가 아니며 구현으로 commit하지 않습니다. |
| backup/ | 어떤 build나 gate도 참조할 수 없는 보존 source입니다. |
| soksak-tauri/ | 보관된 Tauri application source history입니다. 현재 Wails build와 release의 입력이 아닙니다. |
| worktrees/ | 임시 Git worktree입니다. Automation은 Git으로 발견해야 하며 이 path에 의존하면 안 됩니다. |
| bin/ | Workspace local executable 편의 directory이며 현재 Wails tool이 있습니다. Product binary는 soksak-core/bin/이 소유합니다. |
| frameworks/ | 현재 비어 있으며 REPO-LAYOUT.md의 ownership category가 아닙니다. Ownership 정의 없이 product code를 넣지 않습니다. |
| .task/ 및 .claude/ | Local tool state와 local agent setting입니다. Product source 구분가 아닙니다. |

어떤 repository도 parent-relative path, 주입된 workspace root, symlink로 다른 repository를
찾으면 안 됩니다. Repository 간 사용은 공개 package 또는 선언된 environment를 통합니다.

### 작업 대상 terminal repository

~~~text
~/soksak/wails3beta/
├── soksak-core/                                  application 및 host integration
├── soksak-plugins/
│   ├── soksak-plugin-terminal-xterm/             byte renderer 및 비교 기준
│   ├── soksak-plugin-terminal-alacritty/         frame-provider adapter
│   ├── soksak-plugin-terminal-ghostty/           frame-provider adapter
│   ├── soksak-plugin-terminal-kitty/             frame-provider adapter
│   ├── soksak-plugin-terminal-shitty/            frame-provider adapter
│   ├── soksak-plugin-terminal-vt100/             frame-provider adapter
│   └── soksak-plugin-terminal-wezterm/           frame-provider adapter
├── soksak-kits/
│   ├── soksak-kit-plugin-terminal/               공유 plugin lifecycle 및 frame presenter
│   └── soksak-kit-sidecar-terminal/              공유 terminal-sidecar 구현
├── soksak-sidecars/
│   ├── soksak-sidecar-pty/                       PTY process
│   ├── soksak-sidecar-terminal-alacritty/        Alacritty frame producer
│   ├── soksak-sidecar-terminal-ghostty/          Ghostty frame producer
│   ├── soksak-sidecar-terminal-kitty/            Kitty frame producer
│   ├── soksak-sidecar-terminal-shitty/           Shitty frame producer
│   ├── soksak-sidecar-terminal-vt100/            VT100 frame producer
│   └── soksak-sidecar-terminal-wezterm/          WezTerm frame producer
├── soksak-contracts/
│   ├── soksak-contract-plugin-terminal/          plugin behavior contract package
│   ├── soksak-contract-terminal/                 terminal data contract
│   ├── soksak-contract-pty/                      PTY contract
│   ├── soksak-contract-contentview/              content-view contract
│   ├── soksak-contract-control/                  command 및 event envelope contract
│   └── soksak-contract-registry/                 Registry 인증 및 연속성 contract
├── soksak-specs/soksak-spec/                     공개 schema 및 validator
├── wails-services/wails-service-native-compositor/ native composition 적용
├── soksak-plugin-registry/                       공개된 plugin 참조
├── forks/shitty/                                  upstream version 13 유지 fork
├── libraries/xterm-addon-webkit-ime/              직접 만든 WebKit IME library
└── tests/soksak-terminal-tests/                   설치 제품 system test
~~~

Frame-provider plugin repository는 adapter이며 terminal 동작의 복제본 일곱 개가 아닙니다. 공유
동작은 먼저 해당 kit 또는 contract에 반영합니다. Provider repository는 측정으로 provider 고유
adapter 결함이 확인된 경우에만 수정합니다. Sidecar repository는 timing 또는 frame 증거가 producer
또는 transport를 원인으로 식별한 경우에만 수정합니다. 설치 제품 동작은 소유 repository에 집중된
RED가 생긴 후에만 외부 system test에 반영합니다.

## 결함 소유권

| 결함 | 주 소유자 | 조건부 소유자 |
| --- | --- | --- |
| 1–4, 8: 속도, focus, cursor, input, color | soksak-kits/soksak-kit-plugin-terminal | Xterm plugin은 비교 renderer입니다. 측정 결과 frame 생성 또는 transport가 원인이어야 sidecar를 수정합니다. 필요한 공개 관측면만 contract 또는 spec을 수정합니다. |
| 5–7: picker, modal, sidebar blanking | soksak-core frontend visibility 및 layout state | Native surface 적용이 선언된 Core state와 다를 때만 wails-service-native-compositor를 수정합니다. |
| 9: macOS close button | soksak-core/frameworks/wails 및 Core window lifecycle | Native event 구분를 Wails service가 소유하는 경우에만 해당 service를 수정합니다. |
| 10: test interference | soksak-core/internal/application gate 및 application ownership | Core가 소유한 격리 runner 밖에서 user-visible application을 실행하는 경우에만 외부 system test를 수정합니다. |

Terminal plugin repository에 focus, input, theme, performance 수정을 복제하면 안 됩니다. 공통
matrix로 필요성이 입증된 provider adapter 변경과 공통 구현 release 이후의 정확한 dependency 및
release metadata만 반영합니다. Registry 갱신은 마지막 공개 단계이며 runtime 동작 수정 수단이
아닙니다.

## 확인된 구조

Terminal kit는 lifecycle, session, status 동작을 공유합니다. Presentation 구현은 하나가
아닙니다.

| Provider | 입력 및 presentation 경로 |
| --- | --- |
| Xterm | PTY byte가 soksak-plugins/soksak-plugin-terminal-xterm/frontend/src/xterm-renderer.ts의 Xterm parser, presentation, textarea, IME, theme으로 전달됩니다. |
| Alacritty, Ghostty, Kitty, Shitty, VT100, WezTerm | Recovery sidecar frame이 soksak-kits/soksak-kit-plugin-terminal/src/provider-frame-presenter.ts의 pre 및 cell-span presenter와 숨겨진 1px textarea로 전달됩니다. |

soksak-kits/soksak-kit-plugin-terminal/src/provider-terminal-plugin.ts가 공통 provider lifecycle을
소유합니다. 따라서 결함 1–4와 8에는 하나의 renderer parity 계약이 필요합니다. Provider별 focus,
input, color, performance 수정 복제는 금지합니다.

View visibility 구분는 soksak-core/frontend/src/state/ui.ts,
soksak-core/frontend/src/lib/viewPark.ts, soksak-core/docs/tech/NATIVE-SURFACES.md,
soksak-core/docs/tech/UI-GEOMETRY.md에 걸쳐 있습니다. 현재 규칙은 활성 DOM content, document 밖
live surface visibility, parked pixel을 분리합니다. Overlay와 layout motion은 활성 DOM content를
숨기지 않습니다. Live native surface가 숨겨질 때 parked picture가 마지막 applied pixel을
유지합니다. Picker, modal, sidebar별 예외는 금지합니다.

Native close 구분는 soksak-core/frameworks/wails/host.go, window_host_wails.go,
window_commands.go, frontend/src/commands/catalogWindow.ts, frontend/src/state/windowBoot.ts에
걸쳐 있습니다. window.close command 성공만으로 실제 macOS close request의 persistence,
registry cleanup, window destruction을 증명할 수 없습니다.

Test window ownership 구분는 soksak-core/internal/application/restore_gate_test.go,
capture_focus_gate_test.go, run.go에 걸쳐 있습니다. 각 run은 고유 home, runtime, identifier,
socket, owner를 받습니다. Darwin의 `SOKSAK_PRESENTATION=capture-only` window는 compositor에
남아 있으면서 투명하고 mouse-transparent이며 non-key입니다. Capture는 application을 활성화하지
않고 document pixel을 읽습니다. 현재 Wails runtime은 blocking file lock을 통해 한 번에 하나의
test application owner만 허용합니다.

## 사실과 가설

확인된 사실:

- Xterm과 여섯 frame provider는 하나의 terminal behavior contract 및 공유 provider lifecycle
  뒤에서 서로 다른 presentation 구현을 사용합니다.
- 정정된 frame presenter는 row/run DOM identity를 보존하고 input, focus, cursor, render,
  PTY-write sequence와 timestamp를 공개합니다.
- 이전 visibility 식은 overlay와 layout motion 중 활성 DOM content를 숨겼습니다. 현재 하나의
  visibility transaction이 DOM content를 mount 상태로 유지하고 live surface visibility와 parked
  pixel을 분리합니다.
- Clean installed-product candidate matrix는 일곱 provider를 모두 실행했습니다. Capture-only parity
  경로는 공개 DOM input command를 사용하고 `windowFocused=false`를 기록하며 foreground app을
  방해하지 않고 terminal-to-PTY input, cursor 상태, timing을 증명합니다. 색상 자동 판정은 screenshot
  pixel이 아니라 공개 `terminal-screen`의 computed foreground/background, cursor/selection property와
  ANSI 256개 property를 사용합니다. Screenshot과 recording은 사람이 직접 확인하는 관측 증거입니다.
- `ui.input.click`과 `ui.input.key`는 노출된 DOM address를 통해 browser event를 dispatch합니다.
  운영체제 입력이 아니므로 native pointer 또는 keyboard 증거로 인용하면 안 됩니다.
- AppKit은 inactive non-key window의 WebKit에 keyboard input을 전달하지 않습니다. Core의
  `window.input.pointer.click`과 `window.input.key.press`는 이미 active key window를 요구하며
  application을 스스로 활성화하지 않습니다. 별도 `system-native-input` gate가 사람이 없는 native
  runner에서 AppKit NSEvent부터 terminal과 PTY까지의 전달을 증명합니다.
- Capture-only visibility matrix는 picker, settings, sidebar transition에 대해 21개 report와 840개
  frame을 만들었고 blank frame과 violation이 모두 0입니다. 직접 확인한 contact sheet에서도 모든
  terminal image가 유지됩니다.
- 실제 macOS 신호등 닫기 gate는 현재 Core 누적 검증에서 세 번 GREEN입니다.
- 모든 system run은 process, home, runtime, identifier, socket, window, input state 및 open/recorded
  sidecar ownership을 기록합니다. Cleanup 뒤 두 sidecar set이 비고 application이 정상 종료됩니다.
  오래 남았던 test-owned sidecar 두 개는 기록된 identity로 정리했고 사용자 application은 변경하지
  않았습니다.

현재 미공개 candidate:

- 미공개 terminal contract package 0.0.7은 terminal behavior interface 0.0.7, 다섯 semantic theme
  role, 하나의 256색 palette, byte 및 frame renderer의 presentation status 하나를 정의합니다.
- Kit 0.0.19 candidate는 row/run DOM node를 유지하고 input/focus/cursor/render sequence와 timestamp를
  공개하며 frame과 Xterm 양쪽의 host theme 해석 및 공개 computed-style surface를 단독 소유합니다.
- Xterm은 `@xterm/xterm` 6.0.0과 `@xterm/addon-fit` 0.11.0을 사용합니다. WebKit IME dependency는
  package.json/lockfile의 정확한 Git archive 하나로만 소비하며 release workflow의 충돌하는 과거
  source checkout을 제거했습니다.
- Contract, kit, 일곱 renderer plugin의 clean candidate closure가 존재합니다. Source manifest와
  lockfile은 공개 HTTPS dependency를 유지하며 local locator가 없습니다. Candidate provenance는
  정확한 source commit과 dependency archive digest를 기록합니다.
- Clean candidate closure는 capture-only parity 및 visibility matrix를 통과했습니다. Native AppKit
  pointer/keyboard 인증은 unattended runner를 활성화해야 하므로 별도 gate입니다.

임시 terminal contract 및 terminal kit archive에서 생성한 candidate 증거는 무효입니다. Kit source
manifest가 외부 local archive를 사용하도록 임시 변경됐고 pnpm은 해당 dependency를 lockfile에 local
absolute locator와 parent-relative locator 두 형태로 기록했습니다. Source file을 되돌려도 오염된
metadata에서 이미 만든 archive와 downstream 증거는 복구되지 않습니다.

해당 오염 kit archive가 closure에 포함된 candidate archive, parity, visibility, screenshot,
recording 결과는 재사용하면 안 됩니다. 이를 대체하고 8번 색상 인증을 통과한 run 32779972490의
clean renderer closure는 다음과 같습니다. 이후 focus 수정은 kit commit `075a31a`로 전진했으며
아래 색상 closure를 현재 focus closure라고 기록하면 안 됩니다.

| Artifact | Source commit | SHA-256 |
| --- | --- | --- |
| contract-plugin-terminal 0.0.7 | 18c8261 | 3e9fd042b497cb7d44d736e597c56e0279412b134f098458d883277915733356 |
| kit-plugin-terminal 0.0.19 | 017f63c | ddac758f0234d780ccd5a6e13c72f425e81e193000e9f2970dddfcf026703a7b |
| plugin-terminal-alacritty 0.0.16 | e0f01ea | 7e22211b76a671f91596bd077529324a2923668178a7a90c2d6f47525c053c8c |
| plugin-terminal-ghostty 0.0.17 | 46182d6 | 331f5deb89f5a31a58bb8d15599d0bbe19bb245041b6663f7228bb3249cdfd5c |
| plugin-terminal-kitty 0.0.16 | 7a50962 | 781e9237632624912a9b1b548cfd18f93756568adb745baf177e09bc7f2e382f |
| plugin-terminal-shitty 0.0.16 | 48ad712 | a2c469cde29ec54837d87d7a6ea0f811d52c07f80f3d2ac215269ce688b13240 |
| plugin-terminal-vt100 0.0.16 | 40fb549 | b5956da65d10ba3d10bf5c70f2e1a01088c2981d7d729de9bb30f5d2105b4558 |
| plugin-terminal-wezterm 0.0.16 | 24797a1 | 670e0af3e178398817d1184775d2c1dc827e488e4ca077d42be09f156be06e43 |
| plugin-terminal-xterm 0.0.23 | 29d26a8 | 28a1bca790fc6835ec8a3e0c356f342d0ecedd5d935c0fe7ca0a43f06143ccf5 |

Candidate plan SHA-256은
`630486414dd0a83cdd7d4cb54d78c1f6a2a6d7295293d35f13fdf27836a5c51b`입니다. 이 plan은 PTY와 여섯
frame-sidecar archive도 고정합니다. 표와 digest는 closure identity이며 설치 제품 report,
공개 상태/DOM assertion이 자동 판정 증거이고 screenshot과 recording은 직접 관측 증거입니다.

허용되는 local build-time 검증 경로는 TERMINAL-UX-EXECUTION.ko.md의 “Local cross-repository
candidate 검증”에 정의합니다. Consumer manifest 또는 lockfile 직접 편집은 development mode가
아닙니다.

`soksak-spec` commit `9de8149`부터 `25c58b7`까지가 complete candidate transaction을 소유합니다.
Clean exact source staging, dependency SHA-256 검증, staging-only workspace override, repository-owned
Make 검증, canonical package/lock byte 복원, 선언된 generated output 생성, local-locator 거부,
`candidate-build.json`을 포함한 verified archive exit를 수행합니다. 현재 spec source `0a1e217`은
해당 구분를 지키면서 긴 ustar path도 지원합니다. Staging metadata와 `.candidate-inputs`는
archive에 들어가지 않습니다.

## 현재 진행 상태와 차단점

| 결함 | 2026-08-25 상태 |
| --- | --- |
| 1 — 지연 | Candidate parity에서 일곱 provider render 5–11ms, input-to-PTY 6–29ms로 GREEN입니다. 그러나 installed command throughput은 Alacritty에서 3MB/s 기준 RED이므로 결함 전체는 열려 있습니다. |
| 2 — focus | Native RED는 Alacritty에서 `focusSequence=1` 뒤 `focusedInput=false`였습니다. WebKit default mouse action을 취소하는 공통 kit fix `075a31a`가 owner candidate GREEN이며 최종 native 재검증은 열려 있습니다. |
| 3 — active cursor | 공개 active/visible cursor state와 직접 확인한 pixel은 candidate GREEN입니다. Native pointer 직후 active cursor 판정은 2번 이후에 확정합니다. |
| 4 — keyboard input | Capture-only terminal-to-PTY round trip은 일곱 provider GREEN입니다. 최종 AppKit key-to-PTY matrix는 2·3번 이후에 판정합니다. |
| 5–7 — picker/modal/sidebar blanking | Local Darwin candidate GREEN. 21개 report, 840개 frame, blank 0, violation 0이며 contact sheet를 직접 확인했습니다. |
| 8 — 색상 parity | Exact candidate run 32779972490 GREEN. 일곱 provider 모두 같은 다섯 theme role, computed foreground/background와 ANSI 256개를 공개했고 7개 capture를 직접 확인했습니다. 공개 release와 현재 사용자 앱은 구버전이므로 deployed product는 아직 RED입니다. |
| 9 — macOS 신호등 닫기 | 현재 Core 누적 gate에서 실제 AppKit close-button mouse down/up 세 번 GREEN입니다. |
| 10 — test 간섭 | Local GREEN. Capture-only window는 transparent/non-key이고 readiness는 polling 0의 event 기반이며 run마다 고유 ownership을 가집니다. Cleanup은 open/recorded sidecar 0에 도달하고 사용자 app을 건드리지 않습니다. |

Active spec, contract, 공유 kit, 일곱 renderer plugin, PTY, 결정적으로 build 가능한 여섯 frame
sidecar, Core, Registry, terminal-tests, 두 Wails framework service의 build/release command ownership은
Make로 통일했습니다. Tool version은 생태계 owner file에 남고 Actions는 이를 주입해 같은 Make target을
호출합니다. 기록된 source-level arm64 gate는 GREEN이지만 Darwin arm64/x86_64/universal, Linux
arm64/x86_64, Windows x86_64 전체 native matrix는 아직 실행하지 않았습니다.

Shitty build dependency는 upstream version 13을 이름에 포함한 유지 fork branch
`min-median-max/shitty:soksak-provider-13`입니다. Commit `a5f8785f`는 embedded version을 source
commit epoch에서 만들고 deterministic static archive를 사용하며 debug data에서 node work path를
제거합니다. Sidecar `build-dependencies.json`이 해당 exact commit과 Python/LLVM/Ragel version을
소유합니다. 서로 다른 timezone의 독립 arm64 SDK build 두 번이 byte-identical이었고 canonical tree
receipt `86f83d4c`, Sidecar build, 반복 stage, conformance 8개가 GREEN입니다. 다른 native target과 새
owner-only benchmark contract closure는 아직 검증하지 않았습니다.

구현 밖 release 차단점도 명시합니다. `soksak-terminal-tests`는 product-specific인데 아직
`min-median-max` module/reusable-workflow identity에 있으므로 ref를 바꾸기 전에 실제 repository
ownership 결정이 필요합니다. `soksak-contract-registry`에는 LICENSE가 없으며 owner가 license를
선택해야 합니다. 두 값 모두 로컬에서 발명하지 않습니다.

남은 acceptance blocker는 timeout이나 fallback이 아닙니다. WebKit은 native keyboard 전달에 active
key window를 요구합니다. Local capture-only run은 사용자의 foreground session을 침해하면 안 됩니다.
따라서 native matrix는 unattended final Darwin runner가 소유하며 DOM-event 증거로 대체하거나 개발자
desktop을 focus해서는 안 됩니다.

Runner의 unpublished candidate 구분는 구현됐습니다. 각 component owner workflow가 clean exact
commit을 자기 저장소에서 build·검증·봉인하고, 제품 workflow는 선언된 identity와 digest의 artifact
17개만 조합합니다. 제품 workflow는 형제 component source를 읽거나 build하지 않습니다.

## 기준점

현재 Core 기준점은 release v0.0.3, commit
1d140596d9a0c54f14ecb998ae0cce2c4a156f7e입니다. Release 주소는
https://github.com/soksak-ai/soksak/releases/tag/v0.0.3입니다. Multi-platform run
32673034161과 release run 32673381309가 통과했습니다.

| Component | Version |
| --- | --- |
| Alacritty terminal | 0.0.15 |
| Ghostty terminal | 0.0.16 |
| Kitty terminal | 0.0.15 |
| Shitty terminal | 0.0.15 |
| VT100 terminal | 0.0.15 |
| WezTerm terminal | 0.0.15 |
| Xterm terminal | 0.0.22 |
| PTY sidecar | 0.0.7 |
| Terminal plugin kit | 0.0.18 |
| Terminal behavior contract | 0.0.5 |
| Terminal contract package | 0.0.6 |

이 성공 기록은 regression 기준점일 뿐입니다. 제보된 UX 결함이 해결되었다는 증거가 아닙니다.

## 사용자 세션 보호

구현은 사용자 소유 Soksak process, window, socket, home, workspace를 닫거나 재사용하거나
수정하면 안 됩니다. 인계 시점의 PID 41136은 사용자 소유였으며 종료하지 않았습니다. Process
identity는 이 번호로 추정하지 말고 다시 확인해야 합니다.

테스트 instance에는 별도 home, 짧은 runtime path, 고유 identifier, 명시적 socket이
필요합니다. Darwin Unix socket 길이 제한 때문에 긴 임시 runtime path를 사용할 수 없습니다.
모든 테스트 소유 sidecar와 application process는 성공 및 실패 시 종료되어야 합니다. Cleanup은
executable name만으로 process를 선택하면 안 됩니다.

## 완료 구분

모든 provider matrix RED가 GREEN이 되고, 모든 정량 visibility 및 ownership 검사가 통과하며,
screenshot과 motion recording을 직접 확인해야 완료입니다. Build, command 응답, 과거 CI run만으로
이 인계를 종료할 수 없습니다.
