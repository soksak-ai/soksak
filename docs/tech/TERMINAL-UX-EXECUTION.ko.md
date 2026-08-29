---
kind: translation
status: active
canonical: docs/tech/TERMINAL-UX-EXECUTION.md
scope: workspace
---

# 터미널 UX 실행 지시서

이 지시서는 TERMINAL-UX-HANDOFF.ko.md 의 결함에 저장소의 누적 검사를 적용합니다. 제보 번호가
아니라 계약 묶음 순서로 실행합니다.

## 바꿀 수 없는 규칙

- 구현 전에 기계로 판정되는 RED 를 세우고, 그것이 목표 결함 때문에 실패하는지 확인합니다.
- xterm, Alacritty, Ghostty, Kitty, Shitty, VT100, WezTerm 에 매트릭스 테스트 하나를 적용합니다.
- 비공개 DOM, 경로, 타이밍, 적재 순서에 의존하기 전에 부족한 명령·상태·이벤트·DOM 정보를 먼저
  공개합니다.
- 이벤트, 구독, watcher, 콜백을 씁니다. 폴링을 추가하지 않습니다.
- 제한 시간을 늘리거나, 재시도 루프를 넣거나, 테스트를 건너뛰거나, 오버레이 중에 터미널을 숨기지
  않습니다.
- 모달이나 사이드바가 움직이는 동안 뷰를 unmount 하거나 remount 하지 않습니다.
- 제공자마다 포커스·입력·색·성능 동작을 복제하지 않습니다.
- 하위 호환 경로, 대체 경로, 임시 구현을 추가하지 않습니다.
- 사용자가 소유한 애플리케이션이나 사이드카를 종료하거나 재사용하지 않습니다.
- 현재 스크린샷과 녹화를 직접 확인하지 않고 UI 완료를 보고하지 않습니다.

요구가 기술적으로 틀렸다면 RED 기준을 바꾸기 전에 멈춥니다. 충돌과 수정 규칙을 기록하고, 승인
뒤에 규칙·RED·문서를 함께 고칩니다.

## RED 이전의 실패 분류

기준선이나 제품 테스트 전에 `make prepare REGISTRY=http://host:port/` 를 실행한 뒤
`make preflight` 를 실행합니다. Core 전체 검사는 `make verify REGISTRY=http://host:port/` 가
소유합니다. 이 명령은 scripts/ci/prepare-frontend-dependencies.sh 와
scripts/ci/check-build-toolchain.sh 로 위임합니다. prepare 만이 프로세스 간 의존 소유자 잠금 아래에서
고정된 lockfile 을 설치합니다. check 는 읽기 전용이며 `.node-version` 의 Node 선택자,
`frontend/package.json` 의 반영본과 pnpm 선언, 선택된 네이티브 프론트엔드 패키지를 확인합니다.
required, Node, Go, Wails 아키텍처 축을 따로 보고하고 lock 의 SHA-256 을 출력합니다.
`go tool wails3 task verify` 는 모든 제품 테스트보다 먼저 prepare 와 check 를 이 순서로 실행합니다.
일반 toolchain 규칙은 `BUILD-TOOLCHAIN.ko.md` 가 소유합니다.

preflight 결과로 제품 증거가 성립하는지 판정합니다.

| 결과 | 분류 | 조치 |
| --- | --- | --- |
| TOOLCHAIN_MISMATCH, exit 78 | 실행 환경 선결 조건 실패 | 선언된 toolchain 을 선택하고 preflight 를 다시 실행합니다. 제품 코드를 바꾸거나 RED 로 기록하지 않습니다. |
| DEPENDENCY_STATE_INVALID, exit 79 | 의존 설치 실패 | 정확한 lockfile 로 저장소가 소유한 의존 상태를 복구합니다. 캐시를 손으로 지우거나 패키지 설치를 강제하거나 RED 로 기록하지 않습니다. |
| 테스트가 인수 동작에 도달하거나 실행하지 못함 | 테스트 harness 실패 | fixture, 관측 인터페이스, 테스트 소유를 먼저 고칩니다. 제품 결과는 미확정입니다. |
| 목표 단언 전에 무관한 누적 검사가 실패 | 기존 회귀 | 새 작업을 멈추고 별도 RED 와 commit 기록으로 누적 검사를 복구합니다. 목표 RED 로 이름을 바꾸지 않습니다. |
| 선언된 환경이 준비되고, 기준선 경로가 실행되고, 목표 인수 단언이 실패 | 제품 RED | 측정한 실패를 기록하고 구현을 시작합니다. |

모든 증거 기록에는 소스 commit, 필요한 플랫폼, Node·Go·Wails 버전과 실행 아키텍처, pnpm 버전,
의존 lock digest, 테스트 명령, exit code, 처음 실패한 단언 이름을 넣습니다. 환경이 다른 두 실행은
같은 기준선이 아닙니다.

첫 유효 기준선은 통과할 수도 실패할 수도 있습니다. 통과하면 인수 기준을 낮추지 않고, 제보된 결함을
재현하는 집중 시나리오를 추가합니다. 제보를 재현하지 못하면 빠진 조건을 조사 결과로 기록하며,
추정한 RED 를 근거로 구현을 고치지 않습니다.

활성 소스 저장소는 실제로 존재하는 연산만 Make 로 공개합니다. Make 가 명령을 소유하며 버전이나
의존 identity 를 복사하지 않습니다. Node, pnpm, Go, Rust, Python 버전은 각 생태계의 소유자 파일에
넣고, 외부 SDK 저장소·commit·도구·대상 산출물은 `build-dependencies.json` 에 넣습니다. 워크플로는
네이티브 runner 를 선택하고 소유자를 주입한 뒤 같은 Make target 을 호출합니다. 빌드를 YAML 에 다시
구현하거나, 설치된 실행 파일 경로를 소스에 기록하거나, 작업 머신에서 다른 도구를 탐색해서는 안
됩니다.

## 저장소 간 로컬 후보 검증

공개되지 않은 의존을 잇겠다고 소비자 원본 저장소를 고쳐서는 안 됩니다. 다음 위치 표기는 정본 소스
manifest, lockfile, 컴포넌트 manifest, 워크플로, 후보 또는 릴리즈 archive, registry metadata 어디에도
쓸 수 없습니다.

- `file:` 과 `file://`
- `link:` 와 `workspace:`
- 저장소 밖으로 나가는 상위 상대 경로
- `<local-evidence>`, 사용자 디렉터리, 드라이브 경로를 포함한 로컬 절대 경로
- 다른 체크아웃으로 해석되는 심볼릭 링크 또는 주입된 workspace root

`file:../../../../../...` 은 `file:<local-evidence>/...` 보다 안전하지 않습니다. 패키지 관리자가 같은 외부 로컬
의존을 lockfile 기준 상대 경로로 직렬화했을 뿐입니다. 둘 다 저장소 배치에 결합된 것이고 같은
검사에서 실패합니다.

후보를 조립하는 동안 정본 소스 체크아웃은 변하지 않아야 합니다. 후보 조립 도구는 공개되지 않은
의존을 고르려고 원본 `package.json` 이나 lockfile 을 고치거나 다시 만들어서는 안 됩니다. 실행 전후의
소스 worktree 를 기록하고 비교하며, 차이가 있으면 그 실행을 무효로 판정합니다.

후보 closure 하나는 `local/candidates/<closure-id>/` 아래에 선언합니다.

~~~text
candidate-plan.json
contracts/<artifact>
kits/<artifact>
plugins/<artifact>
sidecars/<artifact>
~~~

plan 의 경로는 이 closure 안의 일반 파일만 식별합니다. 각 항목은 kind, id, version, 소스 저장소,
소스 commit, 산출물 크기와 SHA-256, 의존 commit, 필요하면 플랫폼 target 을 기록합니다. contract 와
spec 은 검증 입력이며 실행 시점 plugin·sidecar 컴포넌트 목록에 넣지 않습니다.

빌드 시점 조립은 정본 조립 도구 하나와 버려도 되는 staging 체크아웃을 씁니다. 조립 도구는 plan 과
digest 를 검증하고, 깨끗한 소스 commit 을 snapshot 하고, 내용 주소 방식 staging 전송으로 후보
산출물을 제공하고, 빌드 뒤 staging 상태를 마무리합니다. staging metadata 는 소스가 아니므로 commit
하지 않고 후보 archive 에 복사하지도 않습니다. 개발자나 일회성 스크립트가 같은 결과를 만들려고 의존
metadata 를 편집해서는 안 됩니다. 정본 조립 도구가 어떤 의존 관계를 표현하지 못한다면 제품 도구가
빠진 것입니다. 진행을 멈추고 RED 를 추가한 뒤 조립 도구를 먼저 구현합니다.

`soksak-spec` commit `9de8149` 부터 `25c58b7` 까지가 정본 staging 명령과 archive 종료 명령을
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

plan 에는 `packagePath` 와 `dependencies` 만 넣습니다. 각 의존은 패키지 이름, 산출물 절대 경로,
SHA-256 을 기록합니다. 이 명령은 깨끗한 정확 소스 commit 하나를 archive 하고, 의존 산출물을 검증해
버려도 되는 체크아웃 안으로 복사한 뒤, staging 안에서만 쓰는 `pnpm.overrides` 를 기록합니다. dirty
소스, digest 불일치, 경로 이탈, 심볼릭 링크, 비어 있지 않은 출력 디렉터리는 거부하며 정본 소스는
고치지 않습니다. 두 출력 디렉터리는 미리 존재하는 빈 디렉터리여야 합니다.

종료 명령은 staging 안에서만 설치하고, staging 저장소 root 에서 그 저장소의
`make verify REGISTRY=http://host:port/` 를 실행합니다. 정본 패키지와 lock 바이트를 복원하고,
선언되지 않은 소스 변경을 거부하고, 선언된 생성 산출물만 남기고, `.candidate-inputs` 와 staging 제어
metadata 를 제거하고, 로컬 위치 표기를 거부한 뒤 후보 archive 를 빌드·검증하고
`candidate-build.json` 을 기록합니다. staging 안에서만 쓰던 위치 표기도 마무리 뒤에 남아 있으면
실패입니다. 호출자는 증거를 뽑아낸 뒤 마무리된 staging 체크아웃을 버립니다. 개발 반복마다
릴리즈하는 방식으로 대체하지 않으며, 후보 전체와 설치 제품 매트릭스가 GREEN 이 된 뒤에만 release
train 을 시작합니다.

정본 `soksak-spec` 릴리즈 빌더는 소스 metadata, lockfile, 생성된 archive 에서 로컬 의존 위치 표기를
거부합니다. 시스템 테스트의 후보 plan 은 후보 identity, digest, 검증 입력을 독립적으로 확인합니다.
두 검사가 모두 통과해야 하류 후보가 유효합니다.

정본 metadata 에서 로컬 의존이 발견되면 다음을 모두 무효로 판정합니다.

1. 고쳐진 lockfile 또는 manifest
2. 그 metadata 로 만든 모든 archive
3. 그 archive 로 빌드한 모든 하류 후보
4. 그 closure 에서 만든 모든 테스트 결과, 스크린샷, 녹화

오염을 제거하고, 기록된 소스 commit 에서 closure 전체를 다시 빌드한 뒤, 같은 검사를 다시
실행합니다. 눈에 보이는 manifest 만 되돌려도 이미 만들어진 증거는 복구되지 않습니다. 개발 후보의
증거는 잠정 증거입니다. 최종 증거는 의존 release train 뒤에 정확한 불변 릴리즈 URL 과 digest 로 다시
만듭니다.

## 단계 1 — 관측면

지금 인터페이스로 결함을 판정할 수 없을 때만, 앞으로도 계속 쓸 공개 정보를 추가합니다.

| 관심사 | 필요한 정보 |
| --- | --- |
| renderer | 바이트 또는 프레임, mount sequence, ready sequence, render sequence |
| 시작 | 열린 시각, 첫 표시 프레임 시각, 첫 포커스 가능 입력 시각 |
| 입력 | 포커스된 입력 노드, 커서 표시와 활성 여부, accepted input sequence, PTY write sequence |
| 출력 | received output sequence, rendered output sequence |
| 표시 | 의도한 표시 상태, 적용된 표시 상태, 이유, 오버레이 개수 |
| 레이아웃 | 사이드바와 레이아웃 트랜잭션 단계, committed geometry sequence |
| 창 | 네이티브 close 요청 receipt, 정리 완료 sequence |
| 테스트 소유 | 표현 모드, 소유자 identity, 소유한 프로세스와 창 인벤토리 |

관련 정보는 명령, status, 공개 DOM 으로 제공합니다. 상태 전환은 이벤트로 발행합니다. 이름과 schema
는 도메인 상태를 표현하며 제공자 구현 이름을 담지 않습니다. 이후 인수 검사에서 쓰지 않을 정보는
만들지 않습니다.

RED 는 매트릭스의 각 행에서 무엇이 빠졌거나 틀렸는지 이름과 함께 식별하며 실패해야 합니다. 빈 값,
조용한 누락, 추정값은 실패입니다.

공개 native surface는 browser를 표시하든 terminal을 표시하든 하나의 input realm입니다. DOM 선언의
`data-native-surface-id`가 정확한 owner label입니다. `ui.input.click`, `ui.input.drag`와 관련
command는 surface 상대 좌표의 연속을 그 label의 등록된 input owner로 전달하고 결과에도 label을
보고해야 합니다. Placeholder 위에 host DOM mouse event를 보내거나, owner 호출 없이 성공을 보고하거나,
provider 정보에서 label을 다시 조립하면 RED입니다. Selection GREEN은 engine selection status, 공개 DOM
selection status, selection command가 일치해야 합니다. Copy는 추가로 write 뒤 독립된 공개 clipboard
read가 정확히 같은 text를 반환해야 합니다.

Wheel 행은 `point`, `deltaX`, `deltaY`, `deltaMode`, 네 modifier를 owner 경로 끝까지 보존합니다. GREEN은
서로 독립된 세 사례를 요구합니다. Primary screen history는 PTY write 없이 offset을 바꾸고, mouse
reporting 활성 상태는 engine이 encode한 byte를 정확히 한 번 쓰며, alternate-scroll이 활성인 alternate
screen은 대응하는 cursor-key byte를 정확히 한 번 써야 합니다. 공개 DOM의 route, written count,
sequence는 shell이 받은 hex와 일치해야 합니다. Plugin이나 Core가 escape를 encode하거나, 분수 pixel
delta를 잃거나, effect route 두 개를 보고하면 RED입니다.

## 단계 2 — renderer parity

같은 제공자 행을 명시적으로 다른 두 매트릭스에서 씁니다. 로컬 capture-only 매트릭스는 사용자의
전면 애플리케이션을 보존해야 합니다. 노출된 DOM 주소를 쓰며, `ui.input.click` 과 `ui.input.key` 가
운영체제 증거가 아니라 브라우저 이벤트 경로임을 기록합니다. 네이티브 입력 매트릭스는 사람이 없는
네이티브 runner 의 격리된 대화형 테스트 애플리케이션에서만 실행합니다.

현재 결함 실행 순서는 `색(8) → 네이티브 포커스(2) → 포인터 직후 활성 커서(3) → 네이티브
키보드에서 PTY 까지(4) → 처리량(1)` 입니다. 후보 워크플로 테스트가 이 순서를 고정하며, 뒤 단계의
RED 가 앞 단계의 인증을 막을 수 없습니다.

네이티브 입력 매트릭스의 각 제공자에서:

1. 대상 제공자의 터미널 탭 하나를 엽니다.
2. 반복 루프가 아니라 명시적인 ready 이벤트를 기다립니다.
3. 노출된 terminal-screen 사각형을 해석하고 `window.input.pointer.click` 으로 AppKit mouse
   down/up 한 쌍을 보냅니다.
4. 브라우저의 활성 요소와 공개 포커스 status 가 입력 소유자를 식별하는지 확인합니다.
5. `window.input.key.press` 로 AppKit key down/up 한 쌍을 보냅니다.
6. 입력 sequence 가 PTY write 한 번과 shell marker 출력 한 번이 되는지 확인합니다.
7. 캡처한 프레임에서 활성 커서가 보이는지 확인합니다.
8. 열기에서 표시 프레임까지, 열기에서 포커스 가능 입력까지, 클릭에서 입력 소유자까지, 키에서 PTY
   write 까지, PTY 출력에서 그려진 프레임까지를 측정합니다.
9. 기본 전경·배경, 이름 있는 색 16개, bright 색, inverse, bold, reset 을 포함하는 ANSI fixture
   하나를 적용합니다.

`plugin.send` 는 명령 경로만 증명합니다. `ui.input.key` 는 노출된 브라우저 이벤트 경로만
증명합니다. 둘 다 네이티브 키보드 증거가 아닙니다. `focus()` 가 성공했다는 것도 네이티브 포인터
포커스의 증거가 아닙니다. xterm 은 비교 기준일 뿐 테마의 정본이 아닙니다. 예상 의미를 정의하는 것은
정본 테마 토큰입니다.

수치 제품 기준을 정하기 전에 기존 xterm 과 프레임 제공자의 타이밍 분포를 기록합니다. 구현을 바꾸기
전에 임계값을 RED 테스트에 commit 합니다. 모든 제공자가 같은 의미 계약을 만족해야 합니다. renderer
마다 수치 허용치를 다르게 두려면 측정된 근거가 필요합니다.

커서와 색은 스크린샷으로 직접 확인합니다. 자동 통과·실패는 공개 status 와 DOM 계산 스타일 단언으로
판정합니다. 기본 전경·배경, 커서·선택, ANSI 256색은 `terminal-screen` 공개면에서 읽습니다.
스크린샷은 사람이 보는 관측 증거이며 자동 단언을 대신하지 않습니다.

## 단계 3 — 뷰 표시 트랜잭션

터미널 제공자가 여럿 있는 창 하나를 씁니다. 다음 전환의 모든 프레임을 기록합니다.

- 탭 plus picker 열기와 닫기
- 설정 모달 열기와 닫기
- 동의 모달 열기와 닫기
- 좌우 사이드바 열기, 닫기, 크기 조절
- 사이드바가 움직이는 동안의 탭 전환

모든 프레임에서, 유지 대상 터미널 사각형의 크기가 0보다 크고, display none·hidden visibility·opacity
0·빈 프레임이 아니며, 모달 아래 내용이 보이는 비활성 상태인지 확인합니다. 사이드바가 움직이는
동안 빈 중간 프레임이 없어야 합니다. 오버레이가 끝난 뒤 renderer mount identity, 세션 identity, 이전
픽셀이 유지되어야 합니다. `contentVisible` 은 활성 DOM 슬롯을 mount 된 채 보이는 상태로 유지합니다.
오버레이가 문서 밖 live surface 를 가리면 `surfaceVisible` 은 false입니다. 레이아웃 움직임은 live
surface를 compositor transaction에 유지합니다. 그때는 parked picture 가 live surface 가 돌아올 때까지
마지막으로 적용된 픽셀을 같은 슬롯에 유지합니다. 비활성 사슬은 그림을 유지하지 않습니다.

표시 트랜잭션 하나가 오버레이 가림과 레이아웃 움직임을 함께 소유해야 합니다. 서로 어긋나는 표시
상태를 계산하던 이전 경로는 제거합니다. 호환 분기를 남기지 않습니다.

## 단계 4 — macOS 네이티브 close

실제 macOS 신호등 버튼 클릭으로 RED 증거를 만듭니다. window.close 로 대신하지 않습니다.

네이티브 요청 한 번이 대상 창 하나를 닫고, 문서화된 마지막 창 정책을 적용하며, workspace claim 과
네이티브 표면 정리를 끝내야 합니다. 네이티브 입력 경로와 명령 입력 경로는 입력 구분 이후 정리 계약
하나를 함께 써야 합니다. 다른 창은 변하지 않아야 하고, 요청과 정리 sequence 를 밖에서 확인할 수
있어야 합니다. 전후 스크린샷과 창 인벤토리를 확인합니다.

## 단계 5 — 테스트 프로세스와 창 소유

사용자가 소유한 Soksak 창을 활성 상태로 둔 채, 격리된 환경에서 전체 검사를 실행합니다. RED 는 사용자
인스턴스를 바꾸거나 종료하지 않고 현재의 간섭을 증명해야 합니다.

검사 전·중·후에 사용자 입력 소유자가 바뀌지 않고, 보이는 테스트 창이 늘지 않으며, 사용자 PID,
socket, home, workspace 상태가 변하지 않는지 확인합니다. 실패 경로를 포함해 테스트가 소유한 모든
애플리케이션과 사이드카가 종료되어야 하며, 정리는 테스트 소유자가 발급한 identity 만 골라야 합니다.

Darwin 의 capture-only 창은 컴포지터에 남고, alpha 0 이며, 마우스 입력을 무시하고, non-key 상태를
유지합니다. `window.snapshot` 은 전면 프로세스를 바꾸지 않고 문서를 캡처합니다. WebKit 은
애플리케이션이 비활성이고 창이 non-key 이면 네이티브 키보드 입력을 거부합니다. 이것을 개발자의
데스크톱 포커스나 DOM 이벤트를 네이티브라고 다시 이름 붙이는 방식으로 우회해서는 안 됩니다.
`system-native-input` 은 사람이 없는 네이티브 runner 에서 격리된 대화형 애플리케이션만 씁니다. 두
매트릭스 모두 삭제·건너뛰기·약화의 대상이 아닙니다.

## 실행 환경

### v7 격리 후보 범위

v7 관측은 공개 Registry와 사용자 `soksakv3`에서 분리된 local release transaction이다. 후보
release store는 저장소 작업 트리 밖의 임의 임시 디렉터리가 아니라 다음의 명시된 디렉터리를 사용한다.

`<local-release-store>/soksakv7`

후보 store에는 contract→kit→sidecar→plugin의 완전한 release closure만 배치한다. 실행 runtime은
`<isolated-home>`, identifier는 `com.soksakv7.core`, materialized process prefix는 `soksakv7`로
고정한다. source checkout, 사용자 `soksakv3`의 home/runtime/environment, 공개 Registry는 이 transaction의
입력이나 출력이 아니다. `<local-evidence>`는 Darwin Unix socket 길이 제한을 만족하는 runtime 보조 경로에만
허용하며 release·설정·증거 보관에는 사용하지 않는다.

UI 작업에는 soksak-dev skill 을 쓰고 결과 픽셀을 직접 확인합니다. 현재 Core 바이너리는
soksak-core/bin/sok 와 soksak-core/bin/soksak 입니다. 예전 skill 문서의 낡은 CLI 경로를 쓰지
않습니다.

격리 실행에는 별도 SOKSAK_HOME, Darwin 의 짧은 <local-evidence> 실행 디렉터리, 고유한 identifier 와 소유자, 모든
CLI 호출의 명시적 --socket, 창 범위 요청의 명시적 window 필드가 필요합니다. 로컬 매트릭스와 시각
매트릭스는 `SOKSAK_PRESENTATION=capture-only` 를 쓰고, 사람이 없는 `system-native-input` 인증만
`interactive` 를 씁니다. 현재 Wails 런타임은 GUI 프로세스 둘을 안전하게 공존시키지 못하므로, 테스트
애플리케이션이 수명 전체 동안 저장소 소유 애플리케이션 잠금을 보유합니다. targetWindow 는
window_renderer_wait 에서만 쓰며, 준비 여부는 폴링이 아니라 `soksak.host.ready` 이벤트에서 옵니다.
정리는 테스트가 소유한 정확한 open·recorded 사이드카 인벤토리를 중지하고 app.shutdown.commit 을
호출한 뒤 애플리케이션의 정상 종료를 증명합니다.

명령 schema 는 실행 중인 바이너리에서 확인합니다. 낡은 예시로 추정하지 않습니다. 저장소 root 는 git
으로 확인하며, 추정한 형제 경로로 저장소를 잇지 않습니다.

저장소는 작업 머신의 도구 경로를 기록하지 않습니다. 선택한 환경이 대상 저장소의 소유자 파일을
만족해야 합니다.

| 도구 | 정본 소유자 |
| --- | --- |
| Node | `.node-version` 과 해당 패키지의 `engines.node` 반영본 |
| pnpm | 대상 `package.json#packageManager` |
| Go 와 Wails | `go.mod`; Wails 는 `go tool wails3` 로 호출 |
| Rust | `rust-toolchain.toml` |
| Python | 저장소가 Python 연산을 직접 소유하면 `.python-version`; 외부 SDK 의 Python 은 `build-dependencies.json` |
| 네이티브 target | 명시적 `TARGET=<target-triple>` Make 명령과 Actions runner 매트릭스 |

Apple Silicon 소스 수준 검사에서 실제로 쓰인 Node, Go, Rust, Python 프로세스는 arm64 여야 합니다.
Rosetta 프로세스가 arm64 파일을 크로스 컴파일할 수 있더라도 exit 78 환경 실패입니다. 최종 네이티브
증거는 Core, 사이드카, SDK, 테스트 프로세스 산출물의 헤더까지 모두 검증합니다.

## 증거와 commit

각 단계는 RED 테스트 실행, 확인된 RED 의 테스트 commit, 가장 작은 완전한 구현, 같은 테스트의 GREEN,
누적 검사 실행, 스크린샷과 window.record 확인, 영문 정본과 한글 문서 갱신, fix 또는 feat 와 docs
commit 순서로 진행합니다.

만들어진 시각 증거는 저장소 밖 ~/soksak/wails3beta/evidence/<gate> 에 저장합니다. 생성된 이미지나
녹화는 commit 하지 않습니다.

## 릴리즈 검사와 공개 순서

다섯 단계는 구현과 증거의 구분이며 릴리즈 구분이 아닙니다. 단계가 하나 끝날 때마다 공개하지
않습니다. 모든 단계가 GREEN 이고, 후보 전체가 누적 검사·스크린샷과 녹화 직접 확인·macOS 실행 검사·
Linux 확인·Windows cgo 없는 preflight 를 모두 통과한 뒤에 release train 을 한 번 시작합니다.

release train 을 시작하기 전 순서:

1. 정확한 소스 revision 과 소스 manifest 에서 최종 후보 바이트를 빌드합니다.
2. 정본 validator 로 archive, manifest, 버전, 의존 참조, digest, 크기, target 매트릭스를 확인합니다.
3. 형제 저장소 탐색 없이 후보 closure 를 격리된 환경에 설치합니다.
4. 정확히 그 closure 를 대상으로 제공자 매트릭스와 설치 제품 테스트를 실행합니다.
5. 검증된 commit 만 각 저장소의 main branch 에 merge 하고, 깨끗한 main 체크아웃에서 소스·manifest·
   후보 바이트 검사를 다시 실행합니다.

GitHub Actions 는 최종 네이티브 플랫폼 인증과 공개 수단이며 개발 반복 실행기가 아닙니다. macOS 가
실행할 수 없는 사실을 네이티브 job 이 발견할 수는 있지만, 소스 수준·크로스 빌드·릴리즈 바이트·조립
실패는 Actions 실행 전에 모두 없애야 합니다. 변경 없이 실패한 run 을 다시 실행하지 않습니다. 집중된
RED 를 추가하고 고친 뒤 로컬 검사를 반복하고 새 run 을 시작합니다. publish job 은 모든 빌드·테스트
job 에 의존해야 하므로, 인증이 실패하면 tag 나 릴리즈 asset 을 만들어서는 안 됩니다.

공개 전 네이티브 인증은 소유자가 빌드한, 공개하지 않는 후보 산출물을 씁니다.

1. 변경된 각 컴포넌트 저장소가 자기 Make target 과 정본 spec 포장 도구로 자기 후보를 빌드합니다.
   소스 commit, target, SHA-256 으로 식별되는 Actions 산출물을 올리되 tag 나 릴리즈는 만들지
   않습니다.
2. 제품 구성을 소유한 워크플로는 그 산출물의 identity 를 선언하고 바이트만 내려받습니다. 컴포넌트
   저장소 소스를 체크아웃하거나 살펴보거나 빌드해서는 안 됩니다.
3. 제품 워크플로는 검증한 산출물로 후보 plan 을 만들고 사람 없는 네이티브 매트릭스를 실행합니다.
4. 후보 전용 metadata 와 산출물 위치 표기는 소스 manifest, 릴리즈 archive, Registry 상태에 들어가지
   않습니다. 실패한 후보 run 은 버리며 공개하지 않습니다.

네이티브 인증을 가능하게 하려고 의존을 먼저 공개하면 순서가 뒤집히므로 금지합니다. 2026-08-25 현재
컴포넌트 워크플로는 빌드 경로 뒤에 곧바로 publish 하며, 공개하지 않는 산출물 구분을 아직 제공하지
않습니다. release train 전에 이 구분을 구현하고 테스트해야 합니다.

소스나 선언된 의존이 바뀐 저장소만 다음 의존 순서로 공개합니다.

1. 공개 schema 나 패키지가 바뀐 경우 spec 과 contract
2. 배포하는 공유 구현이 바뀐 경우 kit
3. 프로세스나 프레임 구현이 바뀐 경우 sidecar
4. 참조하는 모든 kit 과 sidecar 릴리즈가 존재하고 plugin manifest 가 정확한 불변 릴리즈를 담은 뒤
   terminal plugin
5. 공개된 컴포넌트 closure 와 Core 릴리즈 후보가 설치 제품 검사와 시각 검사를 함께 통과한 뒤 Core
6. 공개된 Core 와 컴포넌트 바이트가, 검증된 미공개 registry 후보를 통한 최종 clean install 과 smoke
   테스트를 통과한 뒤 Registry

Registry 공개는 갱신을 사용자에게 노출하므로 마지막 공개 commit 이자 릴리즈입니다. 일부만 끝난
train 을 노출해서는 안 됩니다. 개발 중 로컬 릴리즈는 갱신이 막힌 상태를 유지하며, 격리된 clean
install 검증에서만 그 상태를 풉니다. 보관된 Tauri 소스는 릴리즈하지 않습니다.

Registry 공개 뒤에는 비어 있는 새 identity home 에서 공개 registry 로 설치해 최종 smoke 검사를
실행합니다. 이것은 공개 무결성 확인이며 같은 릴리즈를 고칠 권한이 아닙니다. 실패한 불변 릴리즈는
가능하면 registry 에 등록하지 않습니다. RED 를 세우고 새 patch 버전을 공개합니다. asset 덮어쓰기,
tag 이동, 호환 경로 추가, 인수 기준 완화는 금지합니다.

## 최종 인수 조건

최종 검사는 제공자 일곱 개와 모든 전환에 대해, 열기에서 첫 표시 프레임까지, 열기에서 첫 포커스 가능
입력까지, 포인터 클릭에서 활성 입력 소유자까지, 키 이벤트에서 PTY write 까지, PTY 출력에서 그려진
프레임까지를 보고해야 합니다. 오버레이와 사이드바 움직임의 빈 프레임 수는 0이어야 합니다. 활성 커서,
정본 테마 의미, 픽셀 확인이 통과해야 합니다. 테스트 실행 전후로 사용자 입력 소유자가 같아야 하고,
테스트가 소유한 프로세스와 창의 누수 수는 0이어야 합니다.

같은 pane 안의 탭 활성화는 `changed=true`, `layoutMoved=false`, DOM commit 표시 영수증, 만들어내지 않은
레이아웃 트랜잭션을 보고해야 합니다. 탭 전환의 빈 프레임, 겹침 프레임, 네이티브 적용 영수증 불일치
프레임은 모두 0이어야 합니다.

Core exit 검사, 영향을 받는 모든 plugin·kit 검사, macOS 시각 검사와 네이티브 입력 확인, Linux 확인,
Windows cgo 없는 크로스 빌드를 실행합니다. 이후 단계가 누적 검사를 깨뜨리면 그 단계는 미완입니다.
