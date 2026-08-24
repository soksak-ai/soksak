---
kind: translation
status: active
canonical: docs/tech/TERMINAL-UX-HANDOFF.md
scope: workspace
---

# 터미널 UX 결함 인계

이 문서는 2026-08-24 현재 해결되지 않은 결함과 확인된 시작점을 기록합니다. 완료 보고가
아닙니다. 필수 실행 순서와 증거는 TERMINAL-UX-EXECUTION.ko.md에 정의합니다.

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
| soksak-contracts/ | Composition, control, PTY, registry, terminal 경계의 공개 contract와 acceptance package입니다. |
| soksak-specs/ | 공개 schema와 validator의 정본입니다. 공개 state 또는 command 모양을 바꾸면 consumer보다 먼저 수정합니다. |
| soksak-plugin-registry/ | 공개된 plugin release 참조입니다. 구현과 release 이후 metadata를 받으며 terminal 동작을 소유하지 않습니다. |
| wails-services/ | Wails host service입니다. Native compositor와 webview surface 책임이 있습니다. |
| externals/ | 제3자 또는 비교용 source와 외부 system test입니다. Product build는 sibling path가 아니라 고정된 공개 dependency를 사용합니다. |
| local/ | 개발 전용 고정 runtime, source checkout, test input, work state입니다. Product code와 test가 dependency를 여기서 탐색하면 안 됩니다. |
| evidence/ | 생성된 screenshot과 recording입니다. Product source가 아니며 구현으로 commit하지 않습니다. |
| backup/ | 어떤 build나 gate도 참조할 수 없는 보존 source입니다. |
| soksak-tauri/ | 보관된 Tauri application source history입니다. 현재 Wails build와 release의 입력이 아닙니다. |
| worktrees/ | 임시 Git worktree입니다. Automation은 Git으로 발견해야 하며 이 path에 의존하면 안 됩니다. |
| bin/ | Workspace local executable 편의 directory이며 현재 Wails tool이 있습니다. Product binary는 soksak-core/bin/이 소유합니다. |
| frameworks/ | 현재 비어 있으며 REPO-LAYOUT.md의 ownership category가 아닙니다. Ownership 정의 없이 product code를 넣지 않습니다. |
| .task/ 및 .claude/ | Local tool state와 local agent setting입니다. Product source 경계가 아닙니다. |

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
└── externals/soksak-terminal-tests/              설치 제품 system test
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
| 9: macOS close button | soksak-core/frameworks/wails 및 Core window lifecycle | Native event 경계를 Wails service가 소유하는 경우에만 해당 service를 수정합니다. |
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

View visibility 경계는 soksak-core/frontend/src/state/ui.ts,
soksak-core/frontend/src/lib/viewPark.ts, soksak-core/docs/tech/NATIVE-SURFACES.md,
soksak-core/docs/tech/UI-GEOMETRY.md에 걸쳐 있습니다. 현재 규칙은 활성 DOM content, document 밖
live surface visibility, parked pixel을 분리합니다. Overlay와 layout motion은 활성 DOM content를
숨기지 않습니다. Live native surface가 숨겨질 때 parked picture가 마지막 applied pixel을
유지합니다. Picker, modal, sidebar별 예외는 금지합니다.

Native close 경계는 soksak-core/frameworks/wails/host.go, window_host_wails.go,
window_commands.go, frontend/src/commands/catalogWindow.ts, frontend/src/state/windowBoot.ts에
걸쳐 있습니다. window.close command 성공만으로 실제 macOS close request의 persistence,
registry cleanup, window destruction을 증명할 수 없습니다.

Test window ownership 경계는 soksak-core/internal/application/restore_gate_test.go,
capture_focus_gate_test.go, run.go에 걸쳐 있습니다. 각 run은 고유 home, runtime, identifier,
socket, owner를 받습니다. SOKSAK_PRESENTATION=capture-only는 test window를 desktop에 표시하지
않습니다. 현재 Wails runtime은 blocking file lock을 통해 한 번에 하나의 test application owner만
허용합니다.

## 사실과 가설

확인된 사실:

- Xterm과 여섯 frame provider는 서로 다른 presentation 및 input 구현을 사용합니다.
- Frame presenter는 표시할 frame DOM을 교체하며 숨겨진 textarea를 사용합니다.
- 이전 visibility 식은 overlay와 layout motion 중 활성 DOM content를 숨겼습니다.
- Core visibility test와 Xterm/VT100 개발 capture는 통과했지만 일곱 provider installed-product
  visibility matrix는 아직 없습니다.
- 기존 system test는 주로 command 기반 send, read, status, restore 경로를 검사합니다.
- 기존 test는 pointer focus, 실제 keyboard entry, cursor pixel, overlay 및 sidebar motion,
  native traffic-light input, 사용자 desktop 비간섭을 증명하지 않습니다.
- Installed-product matrix는 Kitty sidecar artifact에서 `staging 1/2` 상태를 유지합니다.
  Test-owned process의 SIGQUIT stack은 Go HTTP/2 response-body read 내부의
  `HTTPFetcher.Fetch`에서 정지를 확인했습니다. Registry lock, archive extraction, renderer
  bridge는 정지한 goroutine 경로에 없었습니다.

현재 미공개 candidate:

- 미공개 terminal contract package 0.0.7은 terminal behavior interface 0.0.6, 하나의 256색
  palette, byte 및 frame renderer의 presentation status 하나를 정의합니다.
- Kit candidate는 row/run DOM node를 유지하고 input/focus/cursor/render sequence와 timestamp를
  공개합니다. Packed contract candidate 기준 typecheck와 source test 33개를 통과했습니다.
- Xterm은 `@xterm/xterm` 6.0.0과 `@xterm/addon-fit` 0.11.0을 사용합니다. WebKit IME dependency는
  package.json/lockfile의 정확한 Git archive 하나로만 소비하며 release workflow의 충돌하는 과거
  source checkout을 제거했습니다.
- Contract, kit, 일곱 renderer plugin의 clean candidate closure가 존재합니다. Source manifest와
  lockfile은 공개 HTTPS dependency를 유지하며 local locator가 없습니다. Candidate provenance는
  정확한 source commit과 dependency archive digest를 기록합니다.
- 일곱 provider blank-frame 판정은 아직 증명되지 않았습니다. 결함 5–7을 완료로 분류하면 안 됩니다.

임시 terminal contract 및 terminal kit archive에서 생성한 candidate 증거는 무효입니다. Kit source
manifest가 외부 local archive를 사용하도록 임시 변경됐고 pnpm은 해당 dependency를 lockfile에 local
absolute locator와 parent-relative locator 두 형태로 기록했습니다. Source file을 되돌려도 오염된
metadata에서 이미 만든 archive와 downstream 증거는 복구되지 않습니다.

해당 오염 kit archive가 closure에 포함된 candidate archive, parity, visibility, screenshot,
recording 결과는 재사용하면 안 됩니다. 이를 대체한 clean renderer closure는 다음과 같습니다.

| Artifact | Source commit | SHA-256 |
| --- | --- | --- |
| contract-plugin-terminal 0.0.7 | 0f573cd | 1fd332609d141617372112b43827fc24f30a78f3b8118b3cb1ffe6e5b2bc228d |
| kit-plugin-terminal 0.0.18 | e8754fc | 0587a1fb44d19da0e8dacffa1f51471fd67c76adccb6eb1c240d0dc5e6418950 |
| plugin-terminal-alacritty 0.0.15 | 16c71ce | 2b02a19dc298ad8170f6787468b531640f238536df306da7c05b92411ae1cc43 |
| plugin-terminal-ghostty 0.0.16 | 8bd4805 | a388ac2f267ea41c98a58d4a54e19f7c16851b839f59942f1314a5c6dce908ba |
| plugin-terminal-kitty 0.0.15 | ecb6479 | 43e18e5c157e52018b641e689eb172d80aafb30cca3cd62289685551ac633b99 |
| plugin-terminal-shitty 0.0.15 | 8a30c15 | a2678e89a44bb1cfe9b26c227d932f846384909b6c053768c0c5ec1afdcead8c |
| plugin-terminal-vt100 0.0.15 | bc56b75 | 301ae9fee054101a44a00db0941faff8b8cd50da24bfbfe95a04ef9e1159434e |
| plugin-terminal-wezterm 0.0.15 | ba744e8 | 55e41f83907f6476baa5a20810b886cccfca25435adbb4bb0cf50b833c73dcc6 |
| plugin-terminal-xterm 0.0.22 | 91a724e | 6ae01661d5a1d82ef0ab0b1a114a81713d3d6594fa872cbfc22acea2b805dfcf |

이 표는 renderer package composition만 검증합니다. Sidecar candidate, 설치 제품 parity,
screenshot, motion 증거를 대체하지 않습니다.

허용되는 local build-time 검증 경로는 TERMINAL-UX-EXECUTION.ko.md의 “Local cross-repository
candidate 검증”에 정의합니다. Consumer manifest 또는 lockfile 직접 편집은 development mode가
아닙니다.

`soksak-spec` commit `9de8149`부터 `25c58b7`까지가 complete candidate transaction을 소유합니다.
Clean exact source staging, dependency SHA-256 검증, staging-only workspace override, repository-owned
Make 검증, canonical package/lock byte 복원, 선언된 generated output 투영, local-locator 거부,
`candidate-build.json`을 포함한 verified archive exit를 수행합니다. 현재 spec source `db47a94`는
package install은 package directory에서, Make는 staged repository root에서 실행합니다. Staging
metadata와 `.candidate-inputs`는 archive에 들어가지 않습니다.

## 현재 진행 상태와 차단점

| 결함 | 2026-08-24 상태 |
| --- | --- |
| 1 — 지연 | 미완료. Owner-report schema는 정정됐지만 기존 여섯 report에 폐기된 demand field가 남아 무효입니다. 설치된 일곱 provider timing threshold를 실행하지 않았습니다. |
| 2 — focus | 미완료. Candidate에 공개 focus/input 정보가 있으나 실제 pointer 일곱 provider matrix가 없습니다. |
| 3 — active cursor | 미완료. Cursor state는 공개됐으나 일곱 provider pixel assertion이 없습니다. |
| 4 — keyboard input | 미완료. Input sequence 정보는 있으나 real-keyboard-to-PTY matrix가 없습니다. |
| 5–7 — picker/modal/sidebar blanking | 공유 visibility state와 parked-picture 규칙의 집중 test는 GREEN입니다. 새 clean closure로 설치 제품 일곱 provider frame/motion matrix를 실행하지 않았습니다. |
| 8 — 색상 parity | Candidate가 contract palette를 소비하지만 모든 provider의 semantic/pixel parity는 미증명입니다. |
| 9 — macOS 신호등 닫기 | 실제 native close request의 집중 Core application gate는 GREEN입니다. 최종 누적 gate에 계속 포함됩니다. |
| 10 — test 간섭 | Core capture-only identity와 application ownership은 구현됐습니다. 외부 system workflow의 Darwin runtime path는 아직 고정이며 test-owned process/window leak count가 0이 아닙니다. |

Active spec, contract, 공유 kit, 일곱 renderer plugin, PTY, 결정적으로 build 가능한 다섯 frame
sidecar, Core, Registry, terminal-tests, 두 Wails framework service의 build/release command ownership은
Make로 통일했습니다. Tool version은 생태계 owner file에 남고 Actions는 이를 주입해 같은 Make target을
호출합니다. 기록된 source-level arm64 gate는 GREEN이지만 Darwin arm64/x86_64/universal, Linux
arm64/x86_64, Windows x86_64 전체 native matrix는 아직 실행하지 않았습니다.

남은 build 차단점은 `soksak-sidecar-terminal-shitty`입니다. 최신 remote-tracking commit
`c726e10f`을 포함한 upstream `pg83/shitty` source는 `date.today()`를 `SHITTY_VERSION`에
컴파일합니다. 따라서 fixed source commit도 날짜가 다르면 다른 SDK byte를 만들 수 있습니다.
Staging patch, clock 조작, 존재하지 않는 fork 선언은 금지합니다. Shitty SDK를
`build-dependencies.json`과 sidecar candidate closure에 넣기 전에 명시적 reproducible-build input을
소유하는 public upstream commit이 필요합니다.

구현 밖 release 차단점도 명시합니다. `soksak-terminal-tests`는 product-specific인데 아직
`min-median-max` module/reusable-workflow identity에 있으므로 ref를 바꾸기 전에 실제 repository
ownership 결정이 필요합니다. `soksak-contract-registry`에는 LICENSE가 없으며 owner가 license를
선택해야 합니다. 두 값 모두 로컬에서 발명하지 않습니다.

RED 증거가 필요한 가설:

- Frame DOM 교체가 제보된 지연에 기여할 수 있습니다. Candidate가 교체를 제거했지만 installed provider
  matrix에서 성능 기준을 실행하지 않았습니다.
- Hidden textarea focus transfer가 focus, cursor, keyboard 결함을 일으킵니다.
- 서로 다른 default 및 named color mapping이 renderer 색상 차이를 일으킬 수 있습니다. Candidate는 contract
  palette를 사용하지만 installed Xterm/provider parity를 실행하지 않았습니다.

대응 RED 측정으로 확인하기 전에는 가설을 원인으로 기록하지 않습니다.

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

## 완료 경계

모든 provider matrix RED가 GREEN이 되고, 모든 정량 visibility 및 ownership 검사가 통과하며,
screenshot과 motion recording을 직접 확인해야 완료입니다. Build, command 응답, 과거 CI run만으로
이 인계를 종료할 수 없습니다.
