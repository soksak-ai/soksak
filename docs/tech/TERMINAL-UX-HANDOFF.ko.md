---
kind: translation
status: active
canonical: docs/tech/TERMINAL-UX-HANDOFF.md
scope: workspace
---

# 터미널 UX 결함 인계

이 문서는 2026-08-25 현재 제보된 결함 열 개, 지금까지의 증거, 남은 릴리즈 구분을 기록합니다. 필수
실행 순서와 증거는 TERMINAL-UX-EXECUTION.ko.md 가 정의합니다. 로컬 후보의 GREEN 을 불변 릴리즈의
GREEN 이나 실행하지 않은 네이티브 플랫폼의 GREEN 으로 확대해서는 안 됩니다.

## 제보된 결함

열 항목 모두 인수 조건입니다. 제공자 하나나 발생 조건 하나만 고친 결과는 미완입니다.

1. xterm 이외의 모든 터미널이 느립니다.
2. xterm 이외의 모든 터미널이 포커스를 받지 못합니다.
3. xterm 이외의 모든 터미널에서 입력 커서가 활성화되지 않습니다.
4. xterm 이외의 모든 터미널에서 키보드 입력이 되지 않습니다.
5. 탭 plus 선택 창을 열면 닫을 때까지 각 탭 화면이 사라집니다.
6. 설정이나 다른 모달을 열면 닫을 때까지 각 탭 화면이 사라집니다.
7. 사이드바가 움직이는 동안 각 탭 화면이 사라집니다.
8. 같은 터미널 kit 을 쓰는데 xterm 과 다른 터미널의 색이 다릅니다.
9. macOS 신호등 닫기 버튼으로 창을 닫을 수 없습니다.
10. 테스트가 보이는 앱 창을 반복해서 열고 닫아 사용자 작업을 방해합니다.

## workspace 지도

개발 workspace root 는 ~/soksak/wails3beta 입니다. 아래 컴포넌트 디렉터리 각각에 독립된 저장소가
들어 있습니다. workspace 배치는 실행 시점의 탐색 수단이 아니며, 설치된 컴포넌트는
environment.json 에서 확인합니다.

| workspace root 기준 경로 | 책임 |
| --- | --- |
| soksak-core/ | 현재 Wails 애플리케이션, control CLI, renderer, 프레임워크 어댑터, 애플리케이션 수명주기, Core 검사. 이 인계 문서를 소유한 저장소입니다. |
| soksak-plugins/ | 설치 가능한 plugin 저장소들. 터미널 제공자 저장소 일곱 개가 있습니다. |
| soksak-kits/ | 공유 컴포넌트 구현. soksak-kit-plugin-terminal 은 공통 터미널 수명주기와 프레임 presenter 를, soksak-kit-sidecar-terminal 은 복구 사이드카 런타임을 소유합니다. 예전 terminal-common 과 engine-as-judge 적합성 저장소는 소비자가 없으며 폐기 대상입니다. |
| soksak-sidecars/ | plugin 프로세스 저장소들. PTY 하나와 프레임을 만드는 터미널 사이드카 여섯 개가 있습니다. |
| soksak-contracts/ | 합성, control, PTY, registry, 터미널 구분의 공개 계약과 인수 패키지입니다. |
| soksak-specs/ | 공개 schema 와 validator 의 정본입니다. 공개 상태나 명령 모양을 바꾸면 소비자보다 먼저 고칩니다. |
| soksak-plugin-registry/ | 공개된 plugin 릴리즈 참조입니다. 구현과 릴리즈 뒤의 metadata 를 받으며 터미널 동작을 소유하지 않습니다. |
| wails-services/ | Wails 호스트 서비스입니다. 네이티브 컴포지터와 webview 표면을 책임집니다. |
| forks/ | 직접 유지하는 upstream fork 입니다. `origin` 은 소유 fork, `upstream` 은 원본이며, 유지 branch 이름에 upstream 버전이 들어갑니다. 제품 빌드는 이 경로가 아니라 공개 저장소와 정확한 commit 을 씁니다. |
| libraries/ | xterm-addon-webkit-ime 처럼 직접 만든 재사용 라이브러리입니다. upstream fork 가 아닙니다. |
| externals/ | 고치지 않는 제3자 비교 소스입니다. |
| tests/ | 제품 전용 시스템·인수 저장소입니다. |
| local/ | 개발 전용으로 고정한 런타임, 소스 체크아웃, 테스트 입력, 작업 상태입니다. 제품 코드와 테스트가 여기서 의존을 탐색해서는 안 됩니다. |
| evidence/ | 생성된 스크린샷과 녹화입니다. 제품 소스가 아니며 구현과 함께 commit 하지 않습니다. |
| backup/ | 어떤 빌드나 검사도 참조할 수 없는 보존 소스입니다. |
| soksak-tauri/ | 보관된 Tauri 애플리케이션 소스 이력입니다. 현재 Wails 빌드와 릴리즈의 입력이 아닙니다. |
| worktrees/ | 임시 Git worktree 입니다. 자동화는 Git 으로 찾아야 하며 이 경로에 의존해서는 안 됩니다. |
| bin/ | workspace 로컬 실행 파일 편의 디렉터리이며 현재 Wails 도구가 있습니다. 제품 바이너리는 soksak-core/bin/ 이 소유합니다. |
| frameworks/ | 지금은 비어 있으며 REPO-LAYOUT.md 의 소유 범주가 아닙니다. 소유를 정의하지 않은 채 제품 코드를 넣지 않습니다. |
| .task/ 와 .claude/ | 로컬 도구 상태와 로컬 에이전트 설정입니다. 제품 소스 구분이 아닙니다. |

어떤 저장소도 상위 상대 경로, 주입된 workspace root, 심볼릭 링크로 다른 저장소를 찾아서는 안
됩니다. 저장소 사이의 사용은 공개 패키지나 선언된 환경을 지납니다.

### 작업 대상 터미널 저장소

~~~text
~/soksak/wails3beta/
├── soksak-core/                                  애플리케이션과 호스트 통합
├── soksak-plugins/
│   ├── soksak-plugin-terminal-xterm/             바이트 renderer, 비교 기준
│   ├── soksak-plugin-terminal-alacritty/         프레임 제공자 어댑터
│   ├── soksak-plugin-terminal-ghostty/           프레임 제공자 어댑터
│   ├── soksak-plugin-terminal-kitty/             프레임 제공자 어댑터
│   ├── soksak-plugin-terminal-shitty/            프레임 제공자 어댑터
│   ├── soksak-plugin-terminal-vt100/             프레임 제공자 어댑터
│   └── soksak-plugin-terminal-wezterm/           프레임 제공자 어댑터
├── soksak-kits/
│   ├── soksak-kit-plugin-terminal/               공유 plugin 수명주기와 프레임 presenter
│   └── soksak-kit-sidecar-terminal/              공유 터미널 사이드카 구현
├── soksak-sidecars/
│   ├── soksak-sidecar-pty/                       PTY 프로세스
│   ├── soksak-sidecar-terminal-alacritty/        Alacritty 프레임 생성기
│   ├── soksak-sidecar-terminal-ghostty/          Ghostty 프레임 생성기
│   ├── soksak-sidecar-terminal-kitty/            Kitty 프레임 생성기
│   ├── soksak-sidecar-terminal-shitty/           Shitty 프레임 생성기
│   ├── soksak-sidecar-terminal-vt100/            VT100 프레임 생성기
│   └── soksak-sidecar-terminal-wezterm/          WezTerm 프레임 생성기
├── soksak-contracts/
│   ├── soksak-contract-plugin-terminal/          plugin 동작 계약 패키지
│   ├── soksak-contract-terminal/                 터미널 데이터 계약
│   ├── soksak-contract-pty/                      PTY 계약
│   ├── soksak-contract-contentview/              content-view 계약
│   ├── soksak-contract-control/                  명령·이벤트 envelope 계약
│   └── soksak-contract-registry/                 Registry 인증과 연속성 계약
├── soksak-specs/soksak-spec/                     공개 schema 와 validator
├── wails-services/wails-service-native-compositor/ 네이티브 합성 적용
├── soksak-plugin-registry/                       공개된 plugin 참조
├── forks/shitty/                                  upstream 버전 13 유지 fork
├── libraries/xterm-addon-webkit-ime/              직접 만든 WebKit IME 라이브러리
└── tests/soksak-terminal-tests/                   설치 제품 시스템 테스트
~~~

프레임 제공자 plugin 저장소는 어댑터이며 터미널 동작의 복제본 일곱 개가 아닙니다. 공유 동작은 먼저
해당 kit 이나 계약에 반영합니다. 제공자 저장소는 제공자 고유의 어댑터 결함이 측정으로 확인된
경우에만 고칩니다. 사이드카 저장소는 타이밍이나 프레임 증거가 생성기 또는 전송을 원인으로 지목한
경우에만 고칩니다. 설치 제품 동작은 소유 저장소에 집중된 RED 가 생긴 뒤에만 외부 시스템 테스트에
반영합니다.

## 결함 소유

| 결함 | 주 소유자 | 조건부 소유자 |
| --- | --- | --- |
| 1–4, 8: 속도, 포커스, 커서, 입력, 색 | soksak-kits/soksak-kit-plugin-terminal | xterm plugin 은 비교 renderer 입니다. 측정 결과 프레임 생성이나 전송이 원인일 때만 사이드카를 고칩니다. 계약이나 spec 은 필요한 공개 관측면만 고칩니다. |
| 5–7: picker·모달·사이드바에서 화면이 사라짐 | soksak-core 프론트엔드의 표시·레이아웃 상태 | 네이티브 표면 적용이 선언된 Core 상태와 다를 때만 wails-service-native-compositor 를 고칩니다. |
| 9: macOS 닫기 버튼 | soksak-core/frameworks/wails 와 Core 창 수명주기 | 네이티브 이벤트 구분을 Wails 서비스가 소유하는 경우에만 그 서비스를 고칩니다. |
| 10: 테스트 간섭 | soksak-core/internal/application 의 검사와 애플리케이션 소유 | Core 가 소유한 격리 runner 밖에서 사용자에게 보이는 애플리케이션을 실행하는 경우에만 외부 시스템 테스트를 고칩니다. |

터미널 plugin 저장소에 포커스·입력·테마·성능 수정을 복제해서는 안 됩니다. 공통 매트릭스로 필요성이
증명된 제공자 어댑터 변경과, 공통 구현 릴리즈 뒤의 정확한 의존·릴리즈 metadata 만 반영합니다.
Registry 갱신은 마지막 공개 단계이며 실행 동작을 고치는 수단이 아닙니다.

## 확인된 구조

터미널 kit 은 수명주기·세션·status 동작을 공유합니다. 표현 구현은 하나가 아닙니다.

| 제공자 | 입력과 표현 경로 |
| --- | --- |
| xterm | PTY 바이트가 soksak-plugins/soksak-plugin-terminal-xterm/frontend/src/xterm-renderer.ts 의 xterm 파서, 표현, textarea, IME, 테마로 전달됩니다. |
| Alacritty, Ghostty, Kitty, Shitty, VT100, WezTerm | 복구 사이드카 프레임이 soksak-kits/soksak-kit-plugin-terminal/src/provider-frame-presenter.ts 의 pre·cell-span presenter 와 숨겨진 1px textarea 로 전달됩니다. |

공통 제공자 수명주기는
soksak-kits/soksak-kit-plugin-terminal/src/provider-terminal-plugin.ts 가 소유합니다. 따라서 결함
1–4 와 8 에는 renderer parity 계약 하나가 필요합니다. 제공자마다 포커스·입력·색·성능 수정을
복제하는 것은 금지합니다.

뷰 표시 구분은 soksak-core/frontend/src/state/ui.ts, soksak-core/frontend/src/lib/viewPark.ts,
soksak-core/docs/tech/NATIVE-SURFACES.md, soksak-core/docs/tech/UI-GEOMETRY.md 에 걸쳐 있습니다.
현재 규칙은 활성 DOM 내용, 문서 밖 live surface 의 표시 상태, parked 픽셀을 분리합니다. 오버레이와
레이아웃 움직임은 활성 DOM 내용을 숨기지 않습니다. live 네이티브 표면이 숨겨질 때는 parked picture
가 마지막으로 적용된 픽셀을 유지합니다. picker·모달·사이드바마다 예외를 두는 것은 금지합니다.

네이티브 close 구분은 soksak-core/frameworks/wails/host.go, window_host_wails.go,
window_commands.go, frontend/src/commands/catalogWindow.ts, frontend/src/state/windowBoot.ts 에
걸쳐 있습니다. window.close 명령이 성공했다는 것만으로는 실제 macOS close 요청의 지속, registry
정리, 창 파괴를 증명할 수 없습니다.

테스트 창 소유 구분은 soksak-core/internal/application/restore_gate_test.go,
capture_focus_gate_test.go, run.go 에 걸쳐 있습니다. 각 실행은 고유한 home, runtime, identifier,
socket, 소유자를 받습니다. Darwin 의 `SOKSAK_PRESENTATION=capture-only` 창은 컴포지터에 남아 있으며
투명하고, 마우스 입력을 통과시키고, non-key 상태입니다. 캡처는 애플리케이션을 활성화하지 않고 문서
픽셀을 읽습니다. 현재 Wails 런타임은 파일 잠금으로 한 번에 테스트 애플리케이션 소유자 하나만
허용합니다.

## 현재 정본 상태 — 2026-08-28

현재 로컬 closure는 Contract `0.0.13`, 브라우저 Kit `0.0.71`, Sidecar Kit `0.0.16`, PTY Sidecar
`0.0.13`, 복구 Sidecar 여섯 개와 터미널 Plugin 일곱 개입니다. 선택된 runtime 버전은 다음과
같습니다.

| Provider | 복구 Sidecar | Plugin |
| --- | --- | --- |
| Alacritty | 0.0.23 | 0.0.29 |
| Ghostty | 0.0.23 | 0.0.30 |
| Kitty | 0.0.19 | 0.0.29 |
| Shitty | 0.0.18 | 0.0.29 |
| VT100 | 0.0.22 | 0.0.29 |
| WezTerm | 0.0.22 | 0.0.29 |
| Xterm | 선택한 복구 Sidecar 사용 | 0.0.45 |

정본 로컬 composer는 plan을 한 번 쓰고 두 번째 실행에서 `unchanged`를 반환했습니다. SHA-256은
`a6234d0a49c0377f72e60cd22ff2549c80fdae848d7e0611767ace50518242eb`입니다. Plan은 Core
`f0b39ff9dc01d13a39dfa50e956e50eb58333110`과 terminal system test `0788e45`를 선택합니다.
모든 선택 Plugin·Sidecar owner release는 `created` 뒤 `unchanged`를 반환했고 로컬 release store의
52개 entry가 모두 검증됐습니다.

설치된 일곱 provider의 Darwin arm64 `system-restore` gate는 GREEN입니다. 앱만 다시 시작하는 warm
restart와 PTY daemon 교체를 모두 증명했습니다. Warm restart는 같은 shell/session 소유를 유지했고,
PTY 교체 뒤에는 각 archived marker가 history에 남았으며 새 shell의 실제 입력을 받았습니다. 앱 로그에
`already renders`, `INPUT_WRITE_FAILED`, 응답 정지가 없습니다. Capture-only window는 non-key,
alpha-zero를 유지했습니다. Cleanup은 `open=[]`, `recorded=[]`, 정상 앱 종료와 테스트 identity process
0개를 보고했습니다. archived-restart 캡처 일곱 장을 직접 확인했고 모두 live prompt와
`SOKSAK_ARCHIVED_RESTART_n` marker를 보여 줍니다.

Checkpoint generation은 순서 숫자가 아니라 identity입니다. 새 observation이 pane을 명시적으로
claim하고 그 generation만 checkpoint sequence를 전진시킬 수 있습니다. 다른 generation의 늦은 worker
write는 거부합니다. 새 PTY generation은 이전 viewport를 scrollback으로 옮기고 새 viewport를 지우고
cursor를 home으로 옮긴 뒤 fresh shell output을 적용합니다. Random generation ID의 숫자 크기로 최신성을
비교하는 것은 금지합니다.

File drop도 같은 소유 규칙을 따릅니다. Core는 Plugin/window에 묶인 불투명 일회용 grant를 발급하고
redeem할 때 허용된 raw path만 반환합니다. Login-shell quote는 Terminal Kit이 소유합니다. Core는 shell
family를 열거하거나 `shellText`를 만들지 않습니다.

| 결함 | 현재 증거 |
| --- | --- |
| hang / 남은 render 소유 | 정확한 v3 closure에서 GREEN: 일곱 provider warm restart, PTY 교체, 입력, cleanup. |
| 1 — 지연 | 열려 있음. Owner·restore 처리량 증거는 있지만 현재 closure의 전체 설치 성능 matrix를 다시 실행하지 않았습니다. |
| 2 — 포커스 | 열려 있음. Capture-only DOM focus는 native AppKit focus가 아니며 무인 native gate가 필요합니다. |
| 3 — 활성 커서 | 열려 있음. Engine 상태는 공개됐지만 native pointer에서 활성 cursor까지의 인증이 필요합니다. |
| 4 — 키보드 입력 | 부분 GREEN. Command/DOM 입력과 restart 뒤 shell 입력은 GREEN이며 무인 AppKit key-to-PTY가 남았습니다. |
| 5–7 — picker·modal·sidebar 표시 | 부분 GREEN. 설치된 v7 browser↔Vision glide는 양방향 표시 공백이 없으며 picker/modal/sidebar 가림과 border/dim은 열려 있습니다. |
| 8 — 색 parity | 열려 있음. v3 restore 캡처는 읽을 수 있고 일관되지만 v3에서 전체 계산 style/ANSI matrix를 다시 실행하지 않았습니다. |
| 9 — macOS 신호등 닫기 | 반복 native click을 포함한 Core owner gate가 GREEN입니다. |
| 10 — 테스트 간섭 | 현재 capture-only restore gate에서 GREEN: non-key, focus 이동 없음, exact identity cleanup, 소유 Sidecar 0개. |

2026-08-29 v7 compositor 증분은 provider 예외를 추가하지 않고 중복 presentation 소유권을 제거했습니다.
Browser 0.0.8은 mount된 webview를 intrinsic visible로 유지합니다. Terminal Kit 0.0.77은 Workbench
intrinsic visibility와 Core host presentation을 분리하고 Vision 0.0.16은 intrinsic 축만
`data-native-visible`에 씁니다. 각 owner gate가 통과했고 두 Plugin release는 immutable local release
명령에서 `created` 뒤 `unchanged`를 반환했습니다. v7 revision 39의 `surface.inventory`에서 비활성 Vision과
활성 Browser 선언은 모두 `declaredVisible=true`였고 ghosts, unowned, unapplied, orphans는 비었습니다.
Browser→Vision과 Vision→Browser의 20-frame `tab.switchScan`은 각각 journey 8개가 모두 완료됐고 cancel·
incomplete 0, blank·overlap·native mismatch 목록이 모두 비었습니다. 창에 focus를 주지 않고 녹화 프레임을
직접 확인했으며 흰 공백이나 남은 native surface가 없었습니다. 이는 tab-switch compositor 소유권 결함을
닫는 증거이며 overlay, border, focus-input matrix를 닫는 증거는 아닙니다.

2026-08-29 Alacritty 선택 증분은 이름 붙인 그 행에서만 GREEN입니다. Surface Contract 0.0.5가
owner에 묶인 selection transaction을 정의하고, Render Kit 0.0.26과 Alacritty Sidecar 0.0.35가 gesture
상태, engine selection, 렌더 범위를 소유합니다. Vision 0.0.19는 DOM pointer event와 owner
`SurfacePointerInput` 연속을 모두 그 transaction으로 전달합니다. v7 불변 local release digest는
`bf62dff8926271ca813a48f04320d0db35a0236de69110dfc3e978de1551d64f`이며 두 번째 게시는
`unchanged`였습니다. Core는 공개 native 선언을 정확한 `data-native-surface-id`로 해석하며 native
surface 위에서 host DOM drag를 합성하지 않습니다. 다시 빌드한 v7에서 `ui.input.drag`는
`surface=terminal.win-vug6zo.tab-ms2k2p-1`을 반환했고, selection command와 공개 DOM은 모두
`SELECT_FINAL_13579`를 반환했으며, 창에 focus를 주지 않은 24-frame 녹화에서도 같은 선택 범위를 직접
확인했습니다. Wails host는 주입된 framework clipboard를 통해 `clipboard_read`와 `clipboard_write`를
제공합니다. Vision copy는 `copied=true`였고 독립 read도 같은 18자를 반환했습니다. Clipboard 변경
구독, mouse-reporting 중재, scroll, 나머지 native engine 다섯 개는 열려 있으며 이 행의 증거로 인증하면
안 됩니다.

2026-08-29 Alacritty wheel 증분도 이름 붙인 그 행에서만 GREEN입니다. Surface Contract 0.0.6은
surface point, pixel/line/page unit, 네 modifier를 보존하고 effect route 하나만 허용합니다. Render Kit
0.0.27은 분수 누적과 mode routing을 소유하고, Alacritty Sidecar 0.0.36은 legacy, UTF-8, SGR,
alternate-scroll byte encoding을 소유하며, terminal-surface service는 그 응답을 검증하고 유일한 PTY
writer로 남습니다. Vision 0.0.20은 DOM과 generic owner wheel input을 직렬화된 `surface.wheel` 경로
하나로 전달하고 route, written byte count, sequence를 공개합니다. v7 불변 release digest는 Alacritty
`d5a04200d2f5857bd3364cf9e5c0ffda6685e129f7ba2a69445abbc3d71106af`, Vision
`0833136c4c24a8d6f62522449843fc3cea5920c1e87cc0fcbb2cb2e457f30411`, closure를 맞춘 Xterm Plugin
`c7f7ddaf39f0df849bcf0a86c4a1b8c118cf6f8136c201779be5e940de448bad`이며 두 번째 게시는 모두
`unchanged`였습니다. Batch plan `cb54a4815700710b5a2557fc65580953a9dc63eada3687992ff28a5d2bd5f252`는
component 아홉 개를 설치했습니다. v7에서 history 53행 위의 line wheel `-3`은 `scrollback`,
`written=0`, `offset=3`을 반환했고 캡처 viewport는 line 80에서 78로 이동했습니다. 1000+1006 활성
상태의 wheel up은 `mouse-report`, `written=12`를 반환했으며 shell은
`1b5b3c36343b31363b31334d`(`ESC[<64;16;13M`)를 받았습니다. Alternate screen+1007 활성 상태에서는
`alternate-scroll`, `written=3`을 반환했고 shell은 `1b4f41`(`ESC O A`)을 받았습니다. Ghostty,
Kitty, Shitty, VT100, WezTerm은 열려 있으며 이 문단의 증거로 wheel 경로를 인증하면 안 됩니다.

2026-08-29 Alacritty pointer 증분은 이름 붙인 그 행에서만 GREEN입니다. Surface Contract
0.0.7은 엄격한 down/move/up, button, click count, point, modifier 사실을 정의합니다. Render Kit
0.0.28은 mouse mode 중재를 소유하고 Alacritty Sidecar 0.0.37은 SGR, legacy, UTF-8 인코딩을
소유합니다. terminal-surface service는 effect 하나인 응답을 검증하고 유일한 PTY writer로 남습니다.
Vision 0.0.21은 pointer와 wheel을 input queue 하나로 직렬화하고, grabbed 입력을 `surface.pointer`로
보내며, Shift drag는 engine selection transaction에 남깁니다. Core commit
`8f5b3fc1d16756994c35f402b5d737b8df2ae25c`는 공개 DOM command 면 전체에서 middle/right button과
modifier 네 개를 보존합니다. v7 불변 release digest는 Alacritty
`ef283aa66c60838ede3126fd9e536fae1ceaffabecc82d48fec8dfdde02c8346`, Vision
`0ab2f49472f0071f5a59f25da04d1316b9ba44c90edd8437b7179e7e30dbce0d`, Xterm
`1c7c9cfac285e0ce089b3879e296b1efcad4733f0244ec897d97d8f3dfb2ad4a`이고 두 번째 게시는 모두
`unchanged`였습니다. Batch plan
`29878a3bfcdb03a0575ed31ed8e96076070d74e283eb7d52841b686a7c19eef7`은 component 아홉 개를
environment revision 49로 설치했습니다. 1002+1006 상태에서 down/drag/up 한 번은 pointer sequence
3과 shell hex `1b5b3c303b323b324d1b5b3c33323b363b324d1b5b3c303b363b326d`, 즉
`ESC[<0;2;2M`, `ESC[<32;6;2M`, `ESC[<0;6;2m`을 정확히 만들었습니다. Shift drag는 pointer
sequence를 3으로 유지하면서 selection sequence를 4로 올렸고 `IFT_MODE_READY_2468`을 반환했습니다.

첫 capture는 pixel gate를 낮추지 않고 별도 ownership 결함을 분리했습니다. Non-key capture-only 창은
`windowFocused=false`를 유지했지만 `window.snapshot`이 main document만 반환하여 native pane을
비웠습니다. 새 공개 `surface.snapshot`은 같은 terminal owner를 직접 읽어 112,642-byte PNG를
반환했고, 그 안에서 glyph, cursor, 선택 범위를 확인했습니다. 따라서 빠진 층은 engine paint가
아니었습니다. Core commit `81e33ca35549233bbaf3b4658a33f78218a7515c`는 이제 document-only
capture 위에 적용되어 보이는 모든 native surface를 applied layer 순서로 합성하고, 요청 영역으로
clip하며 alpha를 보존합니다. 보이는 surface가 PNG를 반환하지 않으면 이름 붙여 실패합니다. 다시
빌드한 v7 window snapshot은 588,815 byte와 `nativeComposed=true`, `surfaces=2`, `drawn=2`,
`documentOnly=false`를 반환했습니다. 픽셀을 직접 확인해 dim된 왼쪽 terminal, 활성 오른쪽 terminal,
cursor와 `SHIFT_MODE_READY_24680` 선택 강조가 보였고 capture 전후 input state는 모두
`windowFocused=false`였습니다.

첫 동의 실행에서는 Core 수명주기 경합도 드러났습니다. Vision enabled write가 environment-triggered reload를
마치기 전에 반환하여 뒤따른 Xterm enable이 그 reload와 경합했고, renderer는 활성인데
`이미 등록된 프로그램: terminal-xterm` 오류를 보고했습니다. Core commit
`df255a6c19f8820f980896758e5a58b8d37f6de2`는 모든 enabled-state write가 공유 revision coordinator를
기다리게 합니다. 다시 빌드한 v7에서 두 terminal Plugin을 모두 disable한 뒤 Vision과 Xterm 순서로
enable했으며 네 transaction이 모두 성공했고 설치된 두 Plugin은 error 없이 enabled를 보고했습니다.
유한한 `window.record` 경로도 이제 frame마다 같은 native 합성을 사용합니다. v7 3-frame 실행은
`frames=3`을 반환하고 화면이 정지해 같은 SHA-256인 589,723-byte PNG 세 개를 썼으며, 각 이미지에 두
terminal과 selection이 보였습니다. 전후 모두 `windowFocused=false`였습니다.

Ghostty 0.0.34도 복사한 protocol 구현이 아니라 fork된 libghostty-vt mouse encoder로 같은 pointer 행을
통과했습니다. v7 batch와 exact PTY hex는 `TERMINAL-STANDARD-AUDIT.ko.md`에 기록했습니다. 536,524-byte
합성 capture는 window를 non-key로 유지했고 결과와 cursor를 직접 확인했습니다. Ghostty selection과
wheel은 열려 있습니다.

Kitty 0.0.31도 provider ABI가 공개한 fork의 live `Screen` encoder로 같은 pointer 행을 통과했습니다.
Exact closure identity와 PTY 증거는 `TERMINAL-STANDARD-AUDIT.ko.md`에 기록했습니다. 289,925-byte 합성
capture는 window를 non-key로 유지했고 결과와 cursor를 보여 줬습니다. Kitty selection과 wheel은
열려 있습니다.

Shitty 0.0.30도 provider ABI가 공개한 fork의 기존 live `encodeMouseProtocol` 경로로 pointer 행을
통과했습니다. Exact closure, PTY byte, non-key 합성 capture는
`TERMINAL-STANDARD-AUDIT.ko.md`에 기록했습니다. Shitty selection과 wheel은 열려 있습니다. 첫 실행의
render 손실 원인은 Core가 이름 기반 시작에서 선택된 sidecar version을 버린 것입니다. Core는 이제
name, version, process를 함께 해석하고 held pane 복구용 process-generation event를 공개합니다. 다시
빌드한 v7은 최초 시작부터 exact Shitty 0.0.30을 유지하고 pointer 행을 반복 통과했습니다. VT100과
WezTerm pointer 행도 열려 있습니다.

Release train은 시작하지 않았습니다. Theme, native focus/cursor/keyboard, visibility, performance와 남은
제품 목표는 이 exact closure 또는 이후 완전히 다시 조합한 closure를 사용해야 합니다.

## 폐기된 2026-08-25 snapshot

아래 자료는 역사적 맥락으로만 유지합니다. 현재 closure identity나 완료 증거가 아니며 현재 gate를
건너뛰는 근거로 쓰면 안 됩니다.

확인된 사실:

- xterm 과 프레임 제공자 여섯 개는 터미널 동작 계약 하나와 공유 제공자 수명주기 뒤에서 서로 다른
  표현 구현을 씁니다.
- 정정된 프레임 presenter 는 행·run 의 DOM identity 를 보존하고 입력·포커스·커서·렌더·PTY write
  sequence 와 시각을 공개합니다.
- 이전 표시 계산식은 오버레이와 레이아웃 움직임 중에 활성 DOM 내용을 숨겼습니다. 지금은 표시
  트랜잭션 하나가 DOM 내용을 mount 상태로 유지하고 live surface 의 표시 상태와 parked 픽셀을
  분리합니다.
- 깨끗한 설치 제품 후보 매트릭스가 제공자 일곱 개를 모두 실행했습니다. capture-only parity 경로는
  공개 DOM 입력 명령을 쓰고 `windowFocused=false` 를 기록하며, 전면 앱을 방해하지 않고 터미널에서
  PTY 까지의 입력, 커서 상태, 타이밍을 증명합니다. 색 자동 판정은 스크린샷 픽셀이 아니라 공개
  `terminal-screen` 의 계산된 전경·배경, 커서·선택 속성, ANSI 256개 속성을 씁니다. 스크린샷과
  녹화는 사람이 직접 확인하는 관측 증거입니다.
- `ui.input.click` 과 `ui.input.key` 는 노출된 DOM 주소로 브라우저 이벤트를 발행합니다. 운영체제
  입력이 아니므로 네이티브 포인터나 키보드의 증거로 인용해서는 안 됩니다.
- AppKit 은 비활성 non-key 창의 WebKit 에 키보드 입력을 전달하지 않습니다. Core 의
  `window.input.pointer.click` 과 `window.input.key.press` 는 이미 활성 key 창을 요구하며
  애플리케이션을 스스로 활성화하지 않습니다. 별도의 `system-native-input` 검사가 사람이 없는
  네이티브 runner 에서 AppKit NSEvent 부터 터미널과 PTY 까지의 전달을 증명합니다.
- capture-only 표시 매트릭스는 picker·설정·사이드바 전환에 대해 보고서 21개와 프레임 840개를
  만들었고, 빈 프레임과 위반이 모두 0입니다. 직접 확인한 대조 시트에서도 모든 터미널 이미지가
  유지됩니다.
- 실제 macOS 신호등 닫기 검사는 현재 Core 누적 검증에서 세 번 GREEN 입니다.
- 모든 시스템 실행은 프로세스, home, runtime, identifier, socket, 창, 입력 상태와 open·recorded
  사이드카 소유를 기록합니다. 정리 뒤에는 두 사이드카 집합이 비고 애플리케이션이 정상
  종료됩니다. 오래 남아 있던 테스트 소유 사이드카 두 개는 기록된 identity 로 정리했고 사용자
  애플리케이션은 건드리지 않았습니다.

현재 미공개 후보:

- 미공개 터미널 계약 패키지 0.0.7 은 터미널 동작 인터페이스 0.0.7, 의미 테마 역할 다섯 개, 256색
  팔레트 하나, 바이트 renderer 와 프레임 renderer 공통의 표현 status 하나를 정의합니다.
- kit 0.0.19 후보는 행·run DOM 노드를 유지하고 input·focus·cursor·render sequence 와 시각을
  공개하며, 프레임과 xterm 양쪽의 호스트 테마 해석과 공개 계산 스타일 표면을 단독으로 소유합니다.
- xterm 은 `@xterm/xterm` 6.0.0 과 `@xterm/addon-fit` 0.11.0 을 씁니다. WebKit IME 의존은
  package.json 과 lockfile 의 정확한 Git archive 하나로만 소비하며, 릴리즈 워크플로에 있던 충돌하는
  과거 소스 체크아웃은 제거했습니다.
- 계약, kit, renderer plugin 일곱 개의 깨끗한 후보 closure 가 존재합니다. 소스 manifest 와 lockfile
  은 공개 HTTPS 의존을 유지하며 로컬 위치 표기가 없습니다. 후보 provenance 는 정확한 소스 commit
  과 의존 archive digest 를 기록합니다.
- 깨끗한 후보 closure 는 capture-only parity 매트릭스와 표시 매트릭스를 통과했습니다. 네이티브
  AppKit 포인터·키보드 인증은 사람이 없는 runner 를 켜야 하므로 별도 검사입니다.

임시 터미널 계약과 터미널 kit archive 로 만든 후보 증거는 무효입니다. kit 의 소스 manifest 가 외부
로컬 archive 를 쓰도록 임시로 바뀌었고, pnpm 이 그 의존을 lockfile 에 로컬 절대 경로와 상위 상대
경로 두 형태로 기록했습니다. 소스 파일을 되돌려도 오염된 metadata 로 이미 만든 archive 와 하류
증거는 복구되지 않습니다.

그 오염된 kit archive 를 closure 에 포함한 후보 archive, parity, 표시, 스크린샷, 녹화 결과는 다시
쓰면 안 됩니다. 그것을 대체하고 8번 색 인증을 통과한 run 32779972490 의 깨끗한 renderer closure 는
다음과 같습니다. 이후 포커스 수정은 kit commit `075a31a` 로 전진했으므로, 아래 색 closure 를 현재
포커스 closure 로 기록해서는 안 됩니다.

| 산출물 | 소스 commit | SHA-256 |
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

후보 plan 의 SHA-256 은
`630486414dd0a83cdd7d4cb54d78c1f6a2a6d7295293d35f13fdf27836a5c51b` 입니다. 이 plan 은 PTY 와 프레임
사이드카 여섯 개의 archive 도 고정합니다. 이 표와 digest 가 closure identity 이며, 설치 제품
보고서와 공개 상태·DOM 단언이 자동 판정 증거이고 스크린샷과 녹화는 직접 관측 증거입니다.

허용되는 로컬 빌드 시점 검증 경로는 TERMINAL-UX-EXECUTION.ko.md 의 "저장소 간 로컬 후보 검증" 이
정의합니다. 소비자 manifest 나 lockfile 을 직접 편집하는 것은 개발 모드가 아닙니다.

`soksak-spec` commit `9de8149` 부터 `25c58b7` 까지가 후보 트랜잭션 전체를 소유합니다. 깨끗한 정확
소스 staging, 의존 SHA-256 검증, staging 안에서만 쓰는 workspace override, 저장소가 소유한 Make
검증, 정본 패키지와 lock 바이트 복원, 선언된 생성 산출물 생성, 로컬 위치 표기 거부,
`candidate-build.json` 을 포함한 검증된 archive 종료를 수행합니다. 현재 spec 소스 `0a1e217` 은 그
구분을 지키면서 긴 ustar 경로도 지원합니다. staging metadata 와 `.candidate-inputs` 는 archive 에
들어가지 않습니다.

## 폐기된 2026-08-25 진행 표

| 결함 | 2026-08-25 상태 |
| --- | --- |
| 1 — 지연 | 후보 parity 에서 제공자 일곱 개의 렌더 5–11ms, 입력에서 PTY 까지 6–29ms 로 GREEN 입니다. 그러나 설치된 명령 처리량이 Alacritty 에서 3MB/s 기준 RED 이므로 결함 전체는 열려 있습니다. |
| 2 — 포커스 | 네이티브 RED 는 Alacritty 에서 `focusSequence=1` 뒤 `focusedInput=false` 였습니다. WebKit 기본 마우스 동작을 취소하는 공통 kit 수정 `075a31a` 가 소유자 후보에서 GREEN 이며 최종 네이티브 재검증은 열려 있습니다. |
| 3 — 활성 커서 | 공개 active·visible 커서 상태와 직접 확인한 픽셀은 후보에서 GREEN 입니다. 네이티브 포인터 직후의 활성 커서 판정은 2번 이후에 확정합니다. |
| 4 — 키보드 입력 | capture-only 의 터미널에서 PTY 까지 왕복은 제공자 일곱 개 모두 GREEN 입니다. 최종 AppKit 키에서 PTY 까지의 매트릭스는 2·3번 이후에 판정합니다. |
| 5–7 — picker·모달·사이드바 화면 사라짐 | 로컬 Darwin 후보 GREEN. 보고서 21개, 프레임 840개, 빈 프레임 0, 위반 0이며 대조 시트를 직접 확인했습니다. |
| 8 — 색 parity | 정확한 후보 run 32779972490 GREEN. 제공자 일곱 개 모두 같은 테마 역할 다섯 개, 계산된 전경·배경과 ANSI 256개를 공개했고 캡처 7개를 직접 확인했습니다. 공개 릴리즈와 현재 사용자 앱은 구버전이므로 배포된 제품은 아직 RED 입니다. |
| 9 — macOS 신호등 닫기 | 현재 Core 누적 검사에서 실제 AppKit 닫기 버튼 mouse down/up 세 번 GREEN 입니다. |
| 10 — 테스트 간섭 | 로컬 GREEN. capture-only 창은 투명하고 non-key 이며, 준비 여부는 폴링 0의 이벤트 기반이고, 실행마다 고유한 소유를 가집니다. 정리는 open·recorded 사이드카 0에 도달하고 사용자 앱을 건드리지 않습니다. |

활성 spec, 계약, 공유 kit, renderer plugin 일곱 개, PTY, 결정적으로 빌드되는 프레임 사이드카 여섯
개, Core, Registry, terminal-tests, Wails 프레임워크 서비스 둘의 빌드·릴리즈 명령 소유는 Make 로
통일했습니다. 도구 버전은 각 생태계의 소유자 파일에 남고 Actions 가 그것을 주입해 같은 Make target
을 호출합니다. 기록된 소스 수준 arm64 검사는 GREEN 이지만, Darwin arm64·x86_64·universal, Linux
arm64·x86_64, Windows x86_64 전체 네이티브 매트릭스는 아직 실행하지 않았습니다.

Shitty 빌드 의존은 이름에 upstream 버전 13이 들어간 유지 fork branch
`min-median-max/shitty:soksak-provider-13` 입니다. commit `a5f8785f` 는 내장 버전을 소스 commit
epoch 에서 만들고, 결정적 정적 archive 를 쓰며, 디버그 데이터에서 노드 작업 경로를 제거합니다.
사이드카의 `build-dependencies.json` 이 그 정확한 commit 과 Python·LLVM·Ragel 버전을 소유합니다.
시간대가 다른 독립 arm64 SDK 빌드 두 번이 바이트 단위로 같았고, 정본 트리 receipt `86f83d4c`,
사이드카 빌드, 반복 stage, 적합성 8개가 GREEN 입니다. 다른 네이티브 target 과 새 소유자 전용
benchmark 계약 closure 는 아직 검증하지 않았습니다.

구현 밖의 릴리즈 차단점도 적어 둡니다. `soksak-terminal-tests` 는 제품 전용인데 아직
`min-median-max` module·reusable-workflow identity 아래에 있으므로, ref 를 바꾸기 전에 실제 저장소
소유 결정이 필요합니다. `soksak-contract-registry` 에는 LICENSE 가 없으며 소유자가 라이선스를 골라야
합니다. 두 값 모두 로컬에서 지어내지 않습니다.

남은 인수 차단점은 제한 시간이나 대체 경로 문제가 아닙니다. WebKit 은 네이티브 키보드 전달에 활성
key 창을 요구합니다. 로컬 capture-only 실행은 사용자의 전면 세션을 침해해서는 안 됩니다. 따라서
네이티브 매트릭스는 사람이 없는 최종 Darwin runner 가 소유하며, DOM 이벤트 증거로 대체하거나
개발자 데스크톱을 포커스해서는 안 됩니다.

runner 의 미공개 후보 구분은 구현됐습니다. 각 컴포넌트 소유자 워크플로가 깨끗한 정확 commit 을 자기
저장소에서 빌드·검증·봉인하고, 제품 워크플로는 선언된 identity 와 digest 를 가진 산출물 17개만
조합합니다. 제품 워크플로는 형제 컴포넌트 소스를 읽거나 빌드하지 않습니다.

## 기준점

현재 Core 기준점은 릴리즈 v0.0.3, commit
1d140596d9a0c54f14ecb998ae0cce2c4a156f7e 입니다. 릴리즈 주소는
https://github.com/soksak-ai/soksak/releases/tag/v0.0.3 입니다. 다중 플랫폼 run 32673034161 과 릴리즈
run 32673381309 가 통과했습니다.

| 컴포넌트 | 버전 |
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

이 성공 기록은 회귀 기준점일 뿐입니다. 제보된 UX 결함이 해결됐다는 증거가 아닙니다.

## 사용자 세션 보호

구현은 사용자가 소유한 Soksak 프로세스, 창, socket, home, workspace 를 닫거나 재사용하거나 고쳐서는
안 됩니다. 인계 시점의 PID 41136 은 사용자 소유였으며 종료하지 않았습니다. 프로세스 identity 는 이
번호로 추정하지 말고 다시 확인해야 합니다.

테스트 인스턴스에는 별도 home, 짧은 runtime 경로, 고유한 identifier, 명시적 socket 이 필요합니다.
Darwin 의 Unix socket 길이 제한 때문에 긴 임시 runtime 경로는 쓸 수 없습니다. 테스트가 소유한 모든
사이드카와 애플리케이션 프로세스는 성공하든 실패하든 종료되어야 합니다. 정리는 실행 파일 이름만으로
프로세스를 골라서는 안 됩니다.

## 완료 구분

## v7 격리 관측에서 추가된 결함

### 프롬프트 미출력 판정 규칙

사용자 앱에서 `INPUT_WRITE_FAILED: pane ... is not running`이 보이면 프롬프트 렌더링 결함으로
단정하지 않는다. 먼저 environment의 PTY/engine version, sidecar readiness 기록, pane session 상태를
읽는다. PTY가 살아 있어도 engine의 render thread가 panic하면 shell 출력은 도착하지 않고 입력 대상
pane은 이미 종료된 것으로 보고될 수 있다. `panic` 로그의 첫 engine assertion과 `terminal.status`의
session/generation을 함께 기록한 뒤, 동일한 clean 폐포를 v7에서 재현한다. 사용자 앱의 sidecar를
종료하거나 재설치해 해결하지 않는다.

사용자 앱과 분리된 `soksakv7`에서 다음 두 동작을 별도 결함으로 추적한다.

- 터미널 pane을 클릭한 직후 다음 키 입력이 전달되지 않고 다른 탭을 갔다 돌아와야 입력되는 현상. 클릭의
  native/DOM 이벤트, focus 상태 event, PTY write를 하나의 시퀀스로 기록해 재현한다.
- pane을 전환하거나 복원할 때 이전 pane의 프롬프트·브랜치 문자열이 새 pane 위에 잔상처럼 겹치는 현상.
  frame sequence와 surface generation을 기준으로 이전 세대 frame이 새 세대에 도달하지 않는 것을 기계적으로
  검증하고, 캡처로 최종 픽셀을 확인한다.

두 항목은 기존 2번(포커스)·4번(입력)의 하위 현상으로 숨기지 않고 각각 named assertion을 가진다. RED가
  확인되기 전 구현하지 않으며, 사용자 `soksakv3`에서는 재현·수정하지 않는다.

## 프로젝트별 sidecar identity

Installer가 `environment.json`의 `processRole`과 현재 프로젝트 값으로 materialize한 실행 파일명을
`SOKSAK_SIDECAR_NAME`으로 자식에게 전달한다. Core는 모든 선택 Sidecar의 component id와 materialized
실행 파일명 대응을 `SOKSAK_SIDECAR_BINDINGS`로 전달한다. PTY는 자기 socket·token을 자기 identity에서
파생하고 terminal engine은 bindings의 `soksak-sidecar-pty` 값을 사용해 PTY endpoint를 찾는다. 따라서
같은 runtime root라도 `soksak-sidecar-pty`와 `soksakv7-sidecar-pty`가 endpoint를 공유하지 않으며,
실행 파일명을 추측하거나 하드코딩하지 않는다.

모든 제공자 매트릭스의 RED 가 GREEN 이 되고, 모든 정량 표시 검사와 소유 검사가 통과하며, 스크린샷과
움직임 녹화를 직접 확인해야 완료입니다. 빌드, 명령 응답, 과거 CI 실행만으로 이 인계를 끝낼 수
없습니다.
