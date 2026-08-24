---
kind: translation
status: active
canonical: docs/tech/TERMINAL-UX-EXECUTION.md
scope: workspace
---

# 터미널 UX 실행 지시서

이 지시서는 TERMINAL-UX-HANDOFF.ko.md의 결함에 저장소 누적 gate를 적용합니다. 제보 번호가
아니라 계약 묶음 순서로 실행합니다.

## 변경할 수 없는 규칙

- 구현 전에 기계적으로 판정되는 RED를 세우고 목표 결함 때문에 실패하는지 확인합니다.
- Xterm, Alacritty, Ghostty, Kitty, Shitty, VT100, WezTerm에 하나의 matrix test를 적용합니다.
- Private DOM, path, timing, load order를 사용하기 전에 부족한 command, status, event, DOM
  정보를 공개합니다.
- Event, subscription, watcher, callback을 사용합니다. Polling을 추가하지 않습니다.
- Timeout 증가, retry loop, test skip, overlay 중 terminal 숨김을 사용하지 않습니다.
- Modal 또는 sidebar motion 중 view를 unmount하거나 remount하지 않습니다.
- Provider별 focus, input, color, performance 동작을 복제하지 않습니다.
- 하위 호환 경로, fallback, 임시 구현을 추가하지 않습니다.
- 사용자 소유 application이나 sidecar를 종료하거나 재사용하지 않습니다.
- 현재 screenshot과 recording을 직접 확인하지 않고 UI 완료를 보고하지 않습니다.

요구가 기술적으로 잘못되었다면 RED 기준을 바꾸기 전에 중단합니다. 충돌과 수정 규칙을
기록하고, 승인 후 규칙, RED, 문서를 함께 수정합니다.

## RED 이전 실패 분류

Baseline 또는 product test 전에 `make prepare`를 실행한 뒤 `make preflight`를 실행합니다.
`make verify`가 Core 전체 gate를 소유합니다. 이 명령은
scripts/ci/prepare-frontend-dependencies.sh와 scripts/ci/check-build-toolchain.sh에 위임합니다.
Prepare만 cross-process dependency owner lock 아래에서 frozen lockfile을 materialize합니다.
Check는 read-only이며 `.node-version`의 Node
selector, `frontend/package.json` projection과 pnpm 선언, 선택된 native frontend package를
검사합니다. Required, Node, Go, Wails architecture 축을 별도로 보고하고
lock SHA-256을 출력합니다. `go tool wails3 task verify`는 모든 product test보다 먼저 prepare와
check를 이 순서로 실행합니다. 일반 toolchain 규칙은 `BUILD-TOOLCHAIN.ko.md`가 소유합니다.

Preflight 결과로 product 증거의 존재 여부를 판정합니다.

| 결과 | 분류 | 조치 |
| --- | --- | --- |
| TOOLCHAIN_MISMATCH, exit 78 | 실행 환경 precondition 실패 | 선언된 toolchain을 선택하고 preflight를 다시 실행합니다. Product code를 바꾸거나 RED로 기록하지 않습니다. |
| DEPENDENCY_STATE_INVALID, exit 79 | Dependency materialization 실패 | 정확한 lockfile로 repository 소유 dependency state를 복구합니다. Cache를 수동 삭제하거나 package install을 강제하거나 RED로 기록하지 않습니다. |
| Test가 인수 동작에 도달하거나 실행하지 못함 | Test harness 실패 | Fixture, 관측 interface, test ownership을 먼저 수정합니다. Product 결과는 미확정입니다. |
| 목표 assertion 전에 무관한 누적 gate 실패 | 기존 regression | 새 작업을 중단하고 별도 RED 및 commit 기록으로 누적 gate를 복구합니다. 목표 RED로 이름을 바꾸지 않습니다. |
| 선언된 환경 준비 완료, baseline 경로 실행 완료, 목표 인수 assertion 실패 | Product RED | 측정한 실패를 기록하고 구현을 시작합니다. |

모든 증거 기록에는 source commit, required platform, Node/Go/Wails version과 runtime architecture,
pnpm version, dependency lock digest, test command, exit code, 처음 실패한 named assertion을 포함합니다.
환경이 다른 두 실행은 같은 baseline이 아닙니다.

첫 유효 baseline은 통과하거나 실패할 수 있습니다. 통과하면 인수 기준을 약화하지 않고 제보된
결함을 재현하는 집중 scenario를 추가합니다. 제보를 재현하지 못하면 누락된 조건을 investigation
결과로 기록하며 추정한 RED를 근거로 구현을 수정하지 않습니다.

모든 active source repository는 실제 존재하는 operation을 Make로 공개합니다. Make는 command를
소유하며 version이나 dependency identity를 복사하지 않습니다. Node, pnpm, Go, Rust, Python
version은 생태계 owner file에 두고 external SDK repository, commit, tool, target output은
`build-dependencies.json`에 둡니다. Workflow는 native runner를 선택하고 owner를 주입한 뒤 같은
Make target을 호출합니다. Build를 YAML에 다시 구현하거나 설치된 executable path를 source에
기록하거나 다른 tool을 workstation에서 탐색하면 안 됩니다.

## Local cross-repository candidate 검증

공개되지 않은 dependency를 연결하기 위해 consumer 원본 repository를 수정하면 안 됩니다. 다음
locator는 canonical source manifest, lockfile, component manifest, workflow, candidate 또는 release
archive, registry metadata에서 모두 금지합니다.

- `file:` 및 `file://`
- `link:` 및 `workspace:`
- repository 밖으로 나가는 parent-relative path
- `<local-evidence>`, user directory, drive path를 포함한 local absolute path
- 다른 checkout을 해석하는 symlink 또는 주입된 workspace root

`file:../../../../../...`은 `file:<local-evidence>/...`보다 안전하지 않습니다. Package manager가 같은 외부 local
dependency를 lockfile 기준 상대경로로 직렬화했을 뿐입니다. 둘 다 repository 배치 결합이며 같은
gate에서 실패합니다.

Candidate composition 중 canonical source checkout은 변하지 않아야 합니다. Candidate
materializer는 공개되지 않은 dependency를 선택하기 위해 원본 `package.json` 또는 lockfile을
수정하거나 다시 생성하면 안 됩니다. 실행 전후 source worktree를 기록하고 비교하며 차이가 있으면
해당 실행을 무효로 판정합니다.

하나의 candidate closure는 `local/candidates/<closure-id>/` 아래에 선언합니다.

~~~text
candidate-plan.json
contracts/<artifact>
kits/<artifact>
plugins/<artifact>
sidecars/<artifact>
~~~

Plan의 path는 이 closure 내부 regular file만 식별합니다. 각 entry는 kind, id, version, source
repository, source commit, artifact size와 SHA-256, dependency commit, 필요한 경우 platform target을
기록합니다. Contract와 spec은 validation input이며 runtime plugin/sidecar component 목록에 넣지
않습니다.

Build-time composition은 하나의 canonical materializer와 폐기 가능한 staging checkout을
사용합니다. Materializer는 plan과 digest를 검증하고, clean source commit을 snapshot하고,
content-addressed staging transport로 candidate artifact를 제공하고, build 후 staging state를
finalize합니다. Staging metadata는 source가 아니며 commit하지 않고 candidate archive에 복사하지
않습니다. 개발자나 일회성 script가 이 동작을 흉내 내기 위해 dependency metadata를 편집하면 안
됩니다. Canonical materializer가 dependency edge를 표현하지 못하면 product tool이 누락된
것입니다. 진행을 멈추고 RED를 추가한 뒤 materializer를 먼저 구현합니다.

`soksak-spec` commit `9de8149`부터 `25c58b7`까지가 canonical staging 및 archive-exit command를
제공합니다.

~~~sh
node <spec-package>/release-template/stage-node-candidate.mjs \
  --source <clean-absolute-repository-root> \
  --out <empty-absolute-staging-directory> \
  --plan <absolute-candidate-stage-plan.json>

node <spec-package>/release-template/build-node-candidate.mjs \
  --stage <absolute-staging-directory> \
  --out <empty-absolute-candidate-output-directory> \
  --kind <portable-or-plugin> \
  [--generated <declared-output-path> ...]
~~~

Plan은 `packagePath`와 `dependencies`만 포함합니다. 각 dependency는 package name,
absolute artifact path, SHA-256을 기록합니다. Command는 clean exact source commit 하나를 archive하고
dependency artifact를 검증해 폐기 가능한 checkout 내부로 복사한 뒤 staging-local `pnpm.overrides`를
기록합니다. Dirty source, digest mismatch, path escape, symlink, nonempty output을 거부하며 canonical
source는 수정하지 않습니다. 두 output directory는 미리 존재하는 빈 directory여야 합니다.

Exit command는 staging 내부에서만 install하고 staged repository root에서 repository의
`make verify`를 실행합니다. Canonical package와 lock byte를 복원하고, 선언되지 않은 source 변경을
거부하고, 선언된 generated output만 유지하고, `.candidate-inputs`와 staging control metadata를
제거하고, local locator를 거부한 뒤 candidate archive를 build·검증하고 `candidate-build.json`을
기록합니다. Staging-local locator도 finalization 뒤 남으면 실패입니다. Caller는 증거를 추출한 뒤
finalized staging checkout을 폐기합니다. 개발 반복마다 release하는 방식으로 대체하지 않으며 전체
candidate와 설치 제품 matrix가 GREEN인 뒤에만 release train을 시작합니다.

Canonical `soksak-spec` release builder는 source metadata, lockfile, 생성 archive의 local dependency
locator를 거부합니다. System-test candidate plan은 candidate identity, digest, validation input을
독립적으로 검증합니다. 두 gate가 모두 통과해야 downstream candidate가 유효합니다.

Canonical metadata에서 local dependency가 발견되면 다음을 모두 무효로 판정합니다.

1. 수정된 lockfile 또는 manifest
2. 해당 metadata로 생성한 모든 archive
3. 해당 archive로 build한 모든 downstream candidate
4. 해당 closure에서 생성한 모든 test 결과, screenshot, recording

오염을 제거하고 기록된 source commit에서 전체 closure를 다시 build한 뒤 같은 gate를 재실행합니다.
눈에 보이는 manifest만 되돌려도 이미 생성된 증거는 복구되지 않습니다. Development candidate
증거는 잠정 증거입니다. 최종 증거는 dependency release train 이후 정확한 immutable release URL과
digest로 다시 생성합니다.

## 단계 1 — 관측면

현재 interface로 결함을 판정할 수 없는 경우에만 지속적으로 사용할 공개 정보를 추가합니다.

| 관심사 | 필요한 정보 |
| --- | --- |
| Renderer | byte 또는 frame, mount sequence, ready sequence, render sequence |
| Startup | open time, first visible frame time, first focusable input time |
| Input | focused input node, cursor visible 및 active, accepted input sequence, PTY write sequence |
| Output | received output sequence, rendered output sequence |
| Visibility | desired visibility, applied visibility, reason, overlay count |
| Layout | sidebar 및 layout transaction phase, committed geometry sequence |
| Window | native close-request receipt, cleanup completion sequence |
| Test ownership | presentation mode, owner identity, owned process 및 window inventory |

관련 정보는 command, status, 공개 DOM으로 제공합니다. 상태 전환은 event로 발행합니다. 이름과
schema는 domain state를 표현하며 provider 구현 이름을 포함하지 않습니다. 이후 인수 검사에서
사용하지 않는 정보는 만들지 않습니다.

RED는 각 matrix row에서 누락되거나 잘못된 정보를 이름으로 식별하며 실패해야 합니다. 빈 값,
조용한 누락, 추정값은 실패입니다.

## 단계 2 — renderer parity

같은 provider row를 명시적으로 다른 두 matrix에서 사용합니다. Local capture-only matrix는 사용자
foreground application을 보존해야 합니다. 노출된 DOM address를 사용하며 `ui.input.click`과
`ui.input.key`가 운영체제 증거가 아닌 browser-event 경로임을 기록합니다. Native-input matrix는
사람이 없는 native runner의 격리된 interactive test application에서만 실행합니다.

현재 결함 실행 순서는 `색상(8) → native focus(2) → pointer 직후 active cursor(3) → native
keyboard-to-PTY(4) → throughput(1)`입니다. Candidate workflow test가 이 순서를 고정하며 뒤 단계의
RED가 앞 단계의 인증을 막을 수 없습니다.

Native-input matrix의 각 provider에서:

1. 대상 provider의 terminal tab 하나를 엽니다.
2. Interval loop가 아니라 명시적인 ready event를 기다립니다.
3. 노출된 terminal-screen rectangle을 해석하고 `window.input.pointer.click`로 AppKit mouse
   down/up 한 쌍을 보냅니다.
4. Browser active element와 공개 focus status가 input owner를 식별하는지 확인합니다.
5. `window.input.key.press`로 AppKit key down/up 한 쌍을 보냅니다.
6. Input sequence가 한 번의 PTY write와 한 번의 shell marker output이 되는지 확인합니다.
7. Capture frame에서 활성 cursor가 보이는지 확인합니다.
8. Open to visible frame, open to focusable input, click to input owner, key to PTY write, PTY
   output to rendered frame을 측정합니다.
9. Default foreground와 background, 16 named colors, bright colors, inverse, bold, reset을
   포함하는 ANSI fixture 하나를 적용합니다.

`plugin.send`는 command 경로만 증명합니다. `ui.input.key`는 노출된 browser-event 경로만
증명합니다. 둘 다 native keyboard 증거가 아닙니다. `focus()` 성공도 native pointer-focus 증거가
아닙니다. Xterm은 비교 기준일 뿐 theme 정본이 아닙니다. Canonical theme token이 예상 semantic을
정의합니다.

숫자 제품 기준을 선택하기 전에 기존 Xterm과 frame provider의 timing distribution을 기록합니다.
구현을 바꾸기 전에 threshold를 RED test에 commit합니다. 모든 provider가 동일한 semantic
계약을 충족해야 합니다. Renderer별 숫자 허용치는 측정된 근거가 필요합니다.

Cursor 및 color screenshot을 직접 확인합니다. 자동 pass/fail은 공개 status와 DOM computed-style
assertion으로 판정합니다. Default foreground/background, cursor/selection, ANSI 256개는
`terminal-screen` 공개면에서 읽습니다. Screenshot은 사람이 보는 관측 증거이며 자동 assertion을
대체하지 않습니다.

## 단계 3 — view visibility transaction

여러 terminal provider가 있는 창 하나를 사용합니다. 다음 전환의 모든 frame을 기록합니다.

- 탭 plus picker 열기 및 닫기
- settings modal 열기 및 닫기
- consent modal 열기 및 닫기
- 좌우 sidebar 열기, 닫기, resize
- sidebar motion 중 tab switch

모든 frame에서 유지 대상 terminal rectangle의 크기가 0보다 크고, display none, hidden
visibility, opacity 0, empty frame이 아니며, modal 아래 content가 보이는 비활성 상태인지
검사합니다. Sidebar motion에는 blank intermediate frame이 없어야 합니다. Overlay 종료 후
renderer mount identity, session identity와 이전 pixel이 유지되어야 합니다. `contentVisible`은
활성 DOM slot을 mount 및 visible 상태로 유지합니다. Overlay 또는 layout motion이 document 밖
live surface를 가리면 `surfaceVisible`은 false일 수 있습니다. 이때 parked picture가 live surface가
돌아올 때까지 마지막 applied pixel을 같은 slot에 유지합니다.

하나의 visibility transaction이 overlay occlusion과 layout motion을 소유해야 합니다. 충돌하는
visibility를 계산하는 이전 경로는 제거합니다. Compatibility branch를 유지하지 않습니다.

## 단계 4 — macOS native close

실제 macOS 신호등 버튼 클릭으로 RED 증거를 만듭니다. window.close로 대체하지 않습니다.

Native request 한 번이 대상 window 하나를 닫고, 문서화된 마지막 window 정책을 적용하며,
workspace claim 및 native surface cleanup을 완료해야 합니다. Native와 command input 경로는 input
경계 이후 하나의 cleanup 계약을 사용해야 합니다. 다른 window는 변하지 않아야 하며 request와
cleanup sequence를 외부에서 확인할 수 있어야 합니다. 전후 screenshot과 window inventory를
확인합니다.

## 단계 5 — test process 및 window ownership

사용자 소유 Soksak 창을 활성화한 상태에서 격리된 환경의 full gate를 실행합니다. RED는 사용자
instance를 변경하거나 종료하지 않고 현재 간섭을 증명해야 합니다.

Gate 전, 중, 후에 사용자 input owner가 바뀌지 않고, 보이는 test window가 추가되지 않으며,
사용자 PID, socket, home, workspace state가 변하지 않는지 검사합니다. 실패 경로를 포함해 모든
테스트 소유 application과 sidecar가 종료되어야 하며 cleanup은 test owner가 발급한 identity만
선택해야 합니다.

Darwin capture-only window는 compositor에 남고 alpha 0이며 mouse input을 무시하고 non-key 상태를
유지합니다. `window.snapshot`은 foreground process를 바꾸지 않고 document를 capture합니다.
WebKit은 application이 inactive이고 window가 non-key이면 native keyboard input을 거부합니다. 이를
개발자 desktop focus 또는 DOM event의 native 재명명으로 우회하면 안 됩니다.
`system-native-input`은 사람이 없는 native runner에서만 격리된 interactive application을
사용합니다. 두 matrix 모두 삭제, skip, 약화하면 안 됩니다.

## 실행 환경

UI 작업에는 soksak-dev skill을 사용하고 결과 pixel을 직접 확인합니다. 현재 Core binary는
soksak-core/bin/sok와 soksak-core/bin/soksak입니다. 이전 skill text의 오래된 CLI path를 사용하지
않습니다.

격리 실행에는 별도 SOKSAK_HOME, Darwin의 짧은 <local-evidence> runtime directory, 고유 identifier와 owner,
모든 CLI call의 명시적 --socket, window 범위 request의 명시적 window field가 필요합니다. Local 및
visual matrix는 `SOKSAK_PRESENTATION=capture-only`를 사용하고 사람이 없는
`system-native-input` 인증만 `interactive`를 사용합니다. 현재 Wails runtime은 GUI process 두 개를
안전하게 공존시키지 못하므로 test application은 전체 lifetime 동안 repository-owned application
lock을 소유합니다. targetWindow는 window_renderer_wait에서만 사용하며 readiness는 polling이 아니라
`soksak.host.ready` event에서 옵니다. Cleanup은 정확한 test-owned open/recorded sidecar inventory를
중지하고 app.shutdown.commit을 호출한 뒤 application의 정상 종료를 증명합니다.

실행 중인 binary에서 command schema를 확인합니다. 오래된 예시로 추정하지 않습니다. Git으로
repository root를 확인하며 추정한 sibling path로 repository를 연결하지 않습니다.

Repository는 workstation tool path를 기록하지 않습니다. 선택된 environment는 대상 repository의
owner file을 충족해야 합니다.

| Tool | 정본 owner |
| --- | --- |
| Node | `.node-version`과 해당 package `engines.node` projection |
| pnpm | 대상 `package.json#packageManager` |
| Go 및 Wails | `go.mod`; Wails는 `go tool wails3`로 호출 |
| Rust | `rust-toolchain.toml` |
| Python | Repository가 Python operation을 직접 소유하면 `.python-version`; external SDK Python은 `build-dependencies.json` |
| Native target | 명시적 `TARGET=<target-triple>` Make command와 Actions runner matrix |

Apple Silicon source-level gate에서 실제 사용한 Node, Go, Rust, Python process는 arm64여야 합니다.
Rosetta process가 arm64 file을 cross-compile할 수 있어도 exit 78 환경 실패입니다. 최종 native 증거는
Core, sidecar, SDK, test process artifact의 header도 모두 검증합니다.

## 증거와 commit

각 단계는 RED test 실행, 확인된 RED의 test commit, 가장 작은 완전한 구현, 같은 test의 GREEN,
누적 gate 실행, screenshot 및 window.record 확인, 영문 정본과 한글 문서 갱신, fix 또는 feat와
docs commit 순서로 진행합니다.

생성된 visual evidence는 repository 밖의 ~/soksak/wails3beta/evidence/<gate>에 저장합니다. 생성된
image나 recording을 commit하지 않습니다.

## Release gate 및 공개 순서

다섯 단계는 구현 및 증거 경계이며 release 경계가 아닙니다. 개별 단계가 끝날 때 공개하지
않습니다. 모든 단계가 GREEN이고 전체 candidate가 누적 gate, screenshot과 recording 직접 확인,
macOS runtime gate, Linux 검사, Windows cgo-free preflight를 모두 통과한 뒤 한 번의 release
train을 시작합니다.

Release train 시작 전 순서:

1. 정확한 source revision과 source manifest에서 최종 candidate byte를 build합니다.
2. Canonical validator로 archive, manifest, version, dependency reference, digest, size, target
   matrix를 검사합니다.
3. Sibling repository 탐색 없이 candidate closure를 격리된 environment에 설치합니다.
4. 정확히 그 closure를 대상으로 provider matrix와 설치 제품 test를 실행합니다.
5. 검증된 commit만 각 repository의 main branch에 merge하고 clean main checkout에서 source,
   manifest, candidate-byte gate를 다시 실행합니다.

GitHub Actions는 최종 native-platform 인증 및 공개 수단이며 개발 반복 실행기가 아닙니다. macOS가
실행할 수 없는 사실을 native job이 발견할 수는 있지만 source-level, cross-build, release-byte,
composition 실패는 Actions 실행 전에 모두 제거해야 합니다. 변경 없이 실패한 run을 다시 실행하지
않습니다. 집중된 RED를 추가하고 수정한 뒤 local gate를 반복하고 새 run을 시작합니다. Publish
job은 모든 build 및 test job에 의존해야 하므로 인증 실패 시 tag나 release asset을 만들면 안
됩니다.

공개 전 native 인증은 owner가 build한 nonpublishing candidate artifact를 사용합니다.

1. 변경된 각 component repository가 자기 Make target과 canonical spec packager로 자기 candidate를
   build합니다. Source commit, target, SHA-256으로 식별되는 Actions artifact를 올리되 tag나 release는
   만들지 않습니다.
2. 제품 구성을 소유한 workflow는 해당 artifact identity를 선언하고 byte만 download합니다. Component
   repository source를 checkout, inspect, build하면 안 됩니다.
3. 제품 workflow는 검증한 artifact로 candidate plan을 만들고 unattended native matrix를 실행합니다.
4. Candidate 전용 metadata와 artifact locator는 source manifest, release archive, Registry state에
   들어가지 않습니다. 실패한 candidate run은 폐기하며 공개하지 않습니다.

Native 인증을 가능하게 하려고 dependency를 먼저 공개하면 순서가 뒤집히므로 금지합니다.
2026-08-25 현재 component workflow는 build 경로 뒤에 곧바로 publish하며 이 nonpublishing artifact
경계를 아직 제공하지 않습니다. Release train 전에 이 경계를 구현하고 test해야 합니다.

Source 또는 선언된 dependency가 바뀐 repository만 다음 dependency 순서로 공개합니다.

1. Public schema 또는 package가 바뀐 경우 spec과 contract
2. 배포하는 공유 구현이 바뀐 경우 kit
3. Process 또는 frame 구현이 바뀐 경우 sidecar
4. 참조하는 모든 kit와 sidecar release가 존재하고 plugin manifest가 정확한 immutable release를
   포함한 뒤 terminal plugin
5. 공개된 component closure와 Core release candidate가 전체 설치 제품 및 visual gate를 함께
   통과한 뒤 Core
6. 공개된 Core와 component byte가 검증된 미공개 registry candidate를 통한 최종 clean install 및
   smoke test를 통과한 뒤 Registry

Registry 공개는 update를 사용자에게 노출하므로 마지막 public commit 및 release입니다. 일부만
완료된 train을 노출하면 안 됩니다. 개발 중 development source는 update-blocked 상태를 유지하며
격리된 clean-install 검증에서만 제거합니다. 보관된 Tauri source는 release하지 않습니다.

Registry 공개 후 새 empty identity home에서 public registry로 설치해 최종 smoke gate를
실행합니다. 이는 공개 무결성 확인이며 같은 release를 수정할 권한이 아닙니다. 실패한 immutable
release는 가능한 경우 registry에 등록하지 않습니다. RED를 세우고 새 patch version을 공개합니다.
Asset 덮어쓰기, tag 이동, compatibility path 추가, 인수 기준 완화는 금지합니다.

## 최종 인수 조건

최종 gate는 일곱 provider와 모든 전환에 대해 open to first visible frame, open to first focusable
input, pointer click to active input owner, key event to PTY write, PTY output to rendered frame을
보고해야 합니다. Overlay와 sidebar motion의 blank-frame count는 0이어야 합니다. Active cursor,
canonical theme semantic 및 pixel 검사가 통과해야 합니다. Test run 전후 user input owner가 같고
test-owned process 및 window leak count가 0이어야 합니다.

Core exit gate, 영향을 받는 모든 plugin 및 kit gate, macOS visual 및 native-input 검사, Linux 검사,
Windows cgo-free cross-build를 실행합니다. 이후 단계가 누적 gate를 깨면 해당 단계는 미완료입니다.
