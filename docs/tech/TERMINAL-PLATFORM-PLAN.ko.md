---
kind: translation
status: active
canonical: ./TERMINAL-PLATFORM-PLAN.md
---

# 터미널 플랫폼

## 제품 결과

Soksak 은 터미널의 완전한 화면 상태를 다시 만든 뒤, 스냅샷의 source sequence 이후 지점에서 같은 shell
프로세스에 다시 붙여 복원합니다. 애플리케이션이 실행 중이 아닐 때 만들어진 출력은 정확히 한 번
전달합니다. 종료된 프로세스는 입력이 막힌 archived 화면으로 표현합니다. 원시 출력만 보존하는 것은
완전한 복원이 아니라 축소된 결과입니다.

제품은 xterm 플러그인을 유지하며, 각 구현이 상태·복구·표현·배포 검사를 통과한 뒤 Alacritty, Ghostty,
Kitty, Shitty, vt100-rust, WezTerm 기반 플러그인을 추가할 수 있습니다.

## 공개 컴포넌트

| 컴포넌트 | 버전 | 책임 |
| --- | --- | --- |
| `soksak-spec-sidecar-pty` | `0.0.1` | shell 소유, 순서 있는 source event, renderer·observer 스트림, 절대 확인 응답, 스냅샷 lease |
| `soksak-spec-sidecar-terminal` | `0.0.1` | 터미널 상태 해석, 완전한 스냅샷, checkpoint, 복구 결과 |
| `soksak-spec-plugin-terminal` | `0.0.5` | 관측 가능한 터미널 플러그인 수명주기, 표현, 입력, 명령, 출력 구분 상태, 노출 노드 |
| `soksak-kit-sidecar-terminal` | `0.0.7` | 엔진 제공자 여섯 개 전부를 위한 공유 PTY 관측, 복구 서비스, checkpoint 런타임 |
| `soksak-kit-plugin-terminal` | `0.0.18` | pane 마다 renderer 세대와 크기 barrier 를 직렬화하는 공유 터미널 플러그인 구현 |

`soksak-spec-plugin-terminal` 은 `implements` 로 참조하는 공개 동작 계약입니다. manifest 형식이
아닙니다. 모든 플러그인 manifest 는 계속 `soksak-spec-plugin@0.0.1` 을 씁니다.

## 정확한 계약 버전

모든 공개 제공자 identity 는 형태가 하나입니다.

```ts
type ContractRef = { id: string; version: string }
```

`implements` 는 정확한 `{ id, version }` 을 씁니다. `consumes` 와 `sidecars[].interface` 는
`{ id, requirement }` 를 씁니다. PTY 와 terminal Sidecar 인터페이스는 정확한 `0.0.1` 로 유지하고,
터미널 플러그인 동작 계약은 정확한 `0.0.5` 입니다. 범위 지정에는 교차 버전 증거가 필요합니다. 패키지
의존은 별개이며, 커밋된 소스에서 정확한 원격 commit 또는 불변 릴리즈 asset 을 씁니다. 로컬 경로
override 는 개발 전용이고 릴리즈 입력이 되지 않습니다. 발행된 바이트는 다시 쓰지 않습니다.
`soksak-spec` 은 자기 패키지를 정정하려고 `0.0.2` 로 올라갔으며, 컴포넌트와 인터페이스 버전 `0.0.1` 은
계속 검증합니다.

## 소유

### PTY 사이드카

PTY 사이드카는 shell, 프로세스 세대, 원시 바이트, 그리고 출력·resize·clear·exit 의 전체 순서 하나를
소유합니다. 터미널 시퀀스는 해석하지 않고 터미널 checkpoint 도 저장하지 않습니다.

대화형 renderer 와 터미널 상태 observer 는 서로 다른 attachment 와 절대 source-sequence 확인 응답을
씁니다. 느린 observer 가 shell 을 막는 일은 없습니다. 그 observer 는 gap event 를 받으며, 다시 seed
되기 전까지 완전한 스냅샷을 발행할 수 없습니다. observer 등록은 자식 프로세스가 첫 바이트를 낼 수 있게
되기 전에 끝납니다.

스냅샷 lease 는 renderer 가 붙거나, lease 가 만료되거나, 보존이 실패할 때까지 스냅샷 커서 이후의 모든
source event 를 보존합니다. 실패는 명시합니다.

### 터미널 상태 사이드카

터미널 상태 사이드카는 파싱, 정본 화면 projection, 엔진 checkpoint, 이식 가능한 스냅샷, checkpoint
스케줄링, 암호화, 원자적 저장, 폐기를 소유합니다. renderer view 는 미러 상태를 없애지 않고 파괴될 수
있습니다. singleton 키는 설치된 사이드카 identity 이므로 엔진 사이드카 여러 개가 동시에 실행될 수
있습니다.

모든 제공자는 산출물 둘을 만듭니다.

- 같은 엔진에서 가장 완전하게 복원하기 위한 엔진 checkpoint;
- 적합성 검사, 명시적 교차 엔진 복구, 진단을 위한 이식 가능한 정본 스냅샷.

ANSI 복원 데이터는 표현 인코딩 하나입니다. 정본 데이터 모델이 아닙니다.

### 터미널 플러그인

터미널 플러그인은 자기 renderer, 입력과 IME 동작, 선택, 엔진별 설정, 번역, 진단을 소유합니다. mount 와
unmount 는 표현 자원만 소유합니다. 명시적 close 는 PTY 를 끝내고 복구 상태를 폐기합니다. 애플리케이션
종료는 연결을 해제하고 사이드카가 소유한 프로세스는 보존합니다.

모든 플러그인은 명령, status, 조작 가능한 DOM 또는 native-proxy 노드를 노출합니다. archived 화면은
명시적인 새 shell 또는 제공자 resume 동작이 성공하기 전까지 입력을 거부합니다.

### 공유 kit

사이드카 kit 은 PTY 관측, source 순서, 복구 서비스 전송, 세션 registry, checkpoint 수명주기를 정확히 한
번 구현합니다. 제공자 여섯 개는 자기 엔진 미러 어댑터와 사이드카 identity 만 제공합니다. 제공자
저장소는 이 런타임을 복사하지 않습니다.

플러그인 kit 은 복구 조정, pane 위상, 표준 명령, status 발행, 호스트 I/O 등록, 입력 라우팅, 테마
projection, 네이티브 표면 binding 을 구현할 수 있습니다. 터미널 의미, checkpoint 형식, renderer, 엔진
설정, 제공자 선택, 호환 정책은 정의하지 않습니다.

## 정본 터미널 상태

정본 상태는 관측 가능한 터미널 동작을 기술합니다. primary·alternate 버퍼, scrollback, 커서, 보이는
속성, mode, margin, tab stop, 보호 셀, 행 속성, 제목, 작업 디렉터리, hyperlink, graphics disposition,
미완성 파서 tail. 할당, glyph atlas, damage tracking 의 세부는 제외합니다.

복구 제공자는 정본 상태를 프로세스 세대·source 커서와 함께 저장합니다. 같은 엔진은 이식 가능한
형태로는 손실 없이 표현할 수 없는 상태를 담은 엔진별 checkpoint 를 추가로 저장할 수 있습니다.

## 적합성 어휘와 소유

규범 문서는 `canonical state`, `conformance case`, `reference state` 를 씁니다. `Golden` 은 규범
용어가 아닙니다. reference state 는 외부 명세 또는 명시된 계약 결정을 인용합니다. 후보 엔진의 출력은
증거이며 권위가 아닙니다.

계약은 그 계약만 정의하는 경우에 자기 schema, conformance case, reference state, 단언을 담을 수
있습니다. 재사용 가능한 제품 구현은 실제 소비자 여럿이 같은 코드를 필요로 한 뒤에만 kit 으로
옮깁니다.

## 검증 순서

구현은 완전한 수직 증분으로 진행합니다.

1. 정확한 계약 참조;
2. 순서 있는 PTY observer, 절대 확인 응답, 스냅샷 lease;
3. 같은 PID, 완전한 스냅샷, 분리 중 출력, 실시간 입력을 증명하는 종단 간 터미널 하나;
4. 터미널 플러그인 동작 계약, 그리고 xterm 과 두 번째 플러그인에 필요한 최소 공유 kit;
5. 기존 Alacritty, Ghostty, vt100, WezTerm 상태 제공자;
6. Kitty 와 Shitty 상태 제공자;
7. Ghostty 와 vt100 표현 플러그인;
8. 범용 네이티브 renderer 호스팅;
9. Shitty, Alacritty, Kitty, WezTerm 표현 플러그인;
10. 제공자 여섯·플러그인 일곱 전체 fleet 검사.

이후 증분은 동작하는 수직 경로를 미완성 기반 구조로 교체하는 것으로 시작하지 않습니다.

## 구현 상태

이 절은 검증된 구현 상태를 기록합니다. 제공자는 공유 런타임 적합성과 실제 프로세스 검사를 통과한
뒤에만 셈에 들어갑니다. 엔진 SDK 작업만으로는 제공자가 아닙니다.

| 증분 | 검증된 상태 |
| --- | --- |
| 정확한 계약 참조 | 완료. 공개 참조는 정확한 `{ id, version }` 을 씁니다. |
| 원자적 PTY 관측 | 완료. observer 는 프로세스 출력이 시작될 수 있기 전에 준비됩니다. |
| 스냅샷 lease | warm attachment 에 대해 완료. lease 보존과 명시적 파기를 테스트합니다. |
| 공유 복구 런타임 | warm 복구 완료. 암호화 checkpoint 원시 연산은 소유자 테스트를 통과하며, 완전한 archived 복구는 미완입니다. |
| 복구 제공자 | 6/6: Alacritty, Ghostty, Kitty, Shitty, vt100, WezTerm 이 공통 적합성과 실제 PTY warm 복원을 통과합니다. |
| 터미널 플러그인 | 7/7 저장소, 정확한 manifest 와 번들이 존재합니다. xterm 은 xterm.js 를 쓰고, 플러그인 여섯 개는 실제 제공자의 sequence receipt 프레임을 공유 접근성 presenter 로 그립니다. staged 사이드카 fleet 전체 E2E 는 미완입니다. |
| 공유 플러그인 런타임 | status, PTY·lease·ACK 조정, checkpoint 키 주입, 제공자 프레임 receipt, 조작 가능한 DOM 노드, 접근 가능한 표현이 구현되어 있습니다. |

Shitty revision `dd5c0d8c74f37a69a805a24b160472805a97c869` 은 프로덕션 headless 스냅샷 인터페이스와
평탄한 C ABI 를 제공합니다. 그 `vterm-c-sdk` target 은 renderer, 폰트 백엔드, 애플리케이션, 세션,
네이티브 창 객체 없이 arm64 `libshitty_vt.a`, `libplt.a`, `libstd.a`, `vterm_c.h` 를 만듭니다. C smoke
검사를 통과하며 생성된 산출물은 심볼릭 링크가 아니라 일반 파일입니다. 이 제공자는 공통 적합성과 실제
프로세스 warm 복원 검사를 통과했습니다.

Kitty revision `d5f52872e805aa29837dcfe55d6833ae681805d3` 은 프로덕션 Screen 과 VT 파서를 감싼 제공자
SDK 를 제공합니다. Kitty 제공자는 같은 적합성·실제 프로세스 warm 복원 검사를 통과합니다. 릴리즈 번들은
배포 전에 고정된 Python 런타임을 포함하고 네이티브 install name 을 다시 써야 합니다.

암호화된 archived 복원은 공유 AES-256-GCM checkpoint 저장소 하나를 씁니다. Wails 호스트는 자기 장치
키를 Keychain, Credential Manager, Secret Service 에 만들고, 평문을 JavaScript 에 노출하지 않고 제공자
checkpoint 키를 생성하며, 제공자 키를 그 사이드카 프로세스에만 주입합니다. 공유 kit 은 인증된
checkpoint 왕복, 디스크 평문 부재, 손상된 checkpoint 거부를 증명합니다. 완전한 archived 복구는 제공자
여섯 개 모두에 대해 제품 검사 항목으로 남아 있습니다.

Shitty 제공자 기준선에는 독립된 RED 하나가 있습니다.
`Pty::OwnerDeathReleasesBlockedIoAndHangsUpChild` 는 소유자 release 뒤에도 막힌 writer 를 재현 가능하게
남깁니다. 이 실패는 터미널 스냅샷 인터페이스가 원인이 아니며, 테스트를 약화하거나 제외하지 않고
고쳐야 합니다.

## 요구되는 증거

첫 완전 복구 검사는 실제 프로세스에 대해 다음을 모두 증명합니다.

- 애플리케이션 재시작 전후로 shell PID 가 같습니다;
- 분리된 동안 만들어진 출력을 정확히 한 번 받습니다;
- 조용한 터미널이 새 출력 바이트 없이 복구를 끝냅니다;
- 지속적인 출력에서도 스냅샷과 실시간의 접점에 gap 도 중복도 없습니다;
- 출력·resize·clear 의 순서가 유지됩니다;
- 낡은 프로세스 세대는 거부합니다;
- observer gap 은 완전 충실도를 무효로 만듭니다;
- 손상된 checkpoint 는 pane 하나에만 영향을 줍니다;
- archived 화면은 입력을 거부합니다.

모든 터미널 플러그인은 지원 플랫폼에서 키보드, IME, 포커스, 선택, 클립보드, 마우스, resize, 테마,
접근성, 캡처, renderer 실패 동작을 추가로 증명합니다.

## Wails 애플리케이션 검사

실제 창 검사는 픽셀, 네이티브 표면 기하, 배치 저널을 측정하므로 유지합니다. capture-only 실행은
accessory activation policy 를 쓰고 alpha 0, 마우스 투과, non-key 인 컴포지터 상주 창을 만듭니다.
애플리케이션을 활성화하지 않고 Dock 아이콘도 추가하지 않습니다. `window.snapshot` 이 그 창들에서 문서
픽셀을 읽습니다. SOKSAK_PRESENTATION 은 `interactive` 와 `capture-only` 만 받습니다. 제거된
SOKSAK_UNATTENDED 이름은 대체가 아닙니다. 각 검사 실행은 고유한 home, runtime, identifier, socket,
소유자를 갖습니다. 현재 Wails 런타임은 테스트 프로세스 수명 전체 동안 저장소가 소유한 애플리케이션 잠금
하나로 보호합니다. 정상 종료와 강제 종료 어느 쪽이든 검사 실행이 남기는 검사 소유 프로세스는 0개입니다.

캡처와 녹화는 필수 개발 관측이지만 그것만으로 통과 조건이 되지는 않습니다. 명령이 포커스 소유자, Dock
존재, 프로세스 인벤토리, 표면 기하, 상태 커서, 복구 단계를 반환하며 기계적 판정은 그것을 씁니다.

## 금지된 설계

- 호환 리더, 마이그레이션, 대체 프로토콜 경로;
- 암묵적 제공자 기본값 또는 조용한 엔진 대체;
- event, 구독, 콜백, receipt 가 가능한 곳에서의 폴링;
- 심볼릭 링크, 추측한 상대 경로, 개인 절대 릴리즈 경로;
- 되풀이 가능한 명령과 저장소 테스트 대신 쓰는 임시 테스트 스크립트;
- 코어 소스나 코어 의존 그래프에 있는 엔진·플러그인 이름;
- 완전한 전체 화면 복구라고 보고하는 원시 tail 재생;
- 후보 하나가 통과하지 못한다는 이유로 옳은 표준을 낮추는 것.

## 활성 dependency closure RED

터미널 plugin은 공통 kit을 npm dependency로 compile하지만, kit release 계약은 package를 private으로
표시하고 언어 registry publish를 금지합니다. 현재 local registry는 kit을 0.0.81까지만 해석하며,
pnpm으로 kit 0.0.86을 publish하면 `private` 필드가 거부합니다. 따라서 xterm candidate가 kit
0.0.86의 workspace-root 수정을 깨끗하게 소비할 수 없습니다. private kit에 대한 publisher/registry
정책을 하나의 선언된 경로로 정해야 하며 `file:` locator, source path, 임시 flag 변경은 허용하지
않습니다.

## 완료

터미널 플랫폼은 상태 제공자 여섯 개와 터미널 플러그인 일곱 개가 선언한 모든 플랫폼에서 각자의 독립
검사를 통과하고, identity 하나 아래에서 공존하고, source 불연속 없이 전체 화면 상태를 복원하고,
모든 명령·status·노드 표면을 노출하고, 라이선스 의무를 만족하고, 저장소 소유·실제 프로세스·Wails·성능·
시각 검증을 통과할 때 완료됩니다.
