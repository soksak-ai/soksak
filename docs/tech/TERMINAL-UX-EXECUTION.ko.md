---
kind: translation
status: active
canonical: docs/tech/TERMINAL-UX-EXECUTION.md
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

하나의 provider matrix scenario를 사용합니다.

1. 대상 provider의 terminal tab 하나를 엽니다.
2. Interval loop가 아니라 명시적인 ready event를 기다립니다.
3. 공개된 terminal-screen 또는 terminal-input node를 실제 pointer로 클릭합니다.
4. Browser active element와 공개 focus status가 input owner를 식별하는지 확인합니다.
5. UI 경로로 실제 keyboard input을 전달합니다.
6. Input sequence가 한 번의 PTY write와 한 번의 shell marker output이 되는지 확인합니다.
7. Capture frame에서 활성 cursor가 보이는지 확인합니다.
8. Open to visible frame, open to focusable input, click to input owner, key to PTY write, PTY
   output to rendered frame을 측정합니다.
9. Default foreground와 background, 16 named colors, bright colors, inverse, bold, reset을
   포함하는 ANSI fixture 하나를 적용합니다.

plugin.send는 command 경로만 증명합니다. Keyboard input 증거가 아닙니다. focus() 성공은 pointer
focus 증거가 아닙니다. Xterm은 비교 기준일 뿐 theme 정본이 아닙니다. Canonical theme token이
예상 semantic을 정의합니다.

숫자 제품 기준을 선택하기 전에 기존 Xterm과 frame provider의 timing distribution을 기록합니다.
구현을 바꾸기 전에 threshold를 RED test에 commit합니다. 모든 provider가 동일한 semantic
계약을 충족해야 합니다. Renderer별 숫자 허용치는 측정된 근거가 필요합니다.

Cursor 및 color screenshot을 직접 확인합니다. 확인한 시각 특성은 pixel 또는 token assertion으로
전환합니다. Screenshot은 assertion을 보충하며 대체하지 않습니다.

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
renderer mount identity, session identity, 이전 pixel이 유지되어야 하며 DOM과 native surface가
같은 declared visibility를 사용해야 합니다.

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

먼저 platform이 필요한 view를 hidden 상태로 render 및 capture할 수 있는지 확인합니다. 불가능하면
검증된 제한을 기록하고 별도 test session 또는 runner를 구현합니다. Visual test를 삭제, skip,
약화하지 않습니다.

## 실행 환경

UI 작업에는 soksak-dev skill을 사용하고 결과 pixel을 직접 확인합니다. 현재 Core binary는
soksak-core/bin/sok와 soksak-core/bin/soksak입니다. 이전 skill text의 오래된 CLI path를 사용하지
않습니다.

격리 실행에는 별도 SOKSAK_HOME, Darwin의 짧은 <local-evidence> runtime directory, 고유 identifier, 모든 CLI
call의 명시적 --socket <local-evidence>/<run>.sock, window 범위 request의 명시적 window field가 필요합니다.
targetWindow는 window_renderer_wait에서만 사용합니다. Cleanup은 테스트 소유 sidecar만 종료한 뒤
app.shutdown.commit을 호출합니다.

실행 중인 binary에서 command schema를 확인합니다. 오래된 예시로 추정하지 않습니다. Git으로
repository root를 확인하며 추정한 sibling path로 repository를 연결하지 않습니다.

| Tool | 고정 version 및 path |
| --- | --- |
| Node | 26.7.0 — <workspace-root>/local/runtime/node-v26.7.0-darwin-arm64/bin |
| pnpm | 11.22.0 — <machine-path>/Library/pnpm/.tools/pnpm/11.22.0/bin |
| Task | 3.53.1 — <workspace-root>/local/runtime/task-v3.53.1 |
| Wails | 3.0.0-beta.12 — <workspace-root>/local/runtime/wails3-v3.0.0-beta.12/wails3 |

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
