---
kind: reference
status: active
canonical: self
scope: workspace
---

# 프로세스 모니터 계약

프로세스 모니터 sidebar는 현재 Soksak environment에 속한 process를 읽기 전용으로 보여준다.
workstation 전체를 스캔하거나 executable ID로 소유권을 추정하거나 terminal plugin의 private
state를 읽지 않는다.

## 현재 빈틈

Core의 기존 `process.list`는 Core process manager가 시작한 child만 반환한다. terminal shell은
`soksak-sidecar-pty`가 소유하므로 실행 중인 terminal에서 `process.list = []`가 나올 수 있다.
PTY owner는 이제 `process.inventory`로 실행 중인 shell snapshot을 공개하고 bounded
`process.observe` stream으로 shell과 descendant 시작/갱신/종료 event를 보냅니다. Core도 owner 구현을 읽지 않고
주입된 source를 합산하는 `process.inventory`를 공개하고 애플리케이션 연결 지점에서 public contract로
PTY source를 연결합니다. PTY가 실행 중이 아닐 때 inventory read가 새로 시작하지 않습니다. PTY
0.0.22, Core event relay, Process Monitor 0.0.14가 polling 없이 descendant 시작·종료 전달과 설치 후
시각 acceptance를 닫았습니다. 남은 process-monitor gate는 측정된 sidebar resize sequence이며,
terminal/browser tab 전환 절반은 GREEN입니다.

2026-08-30 격리 설치에서 monitor 0.0.6과 이미 설치된 File Tree 모두 section frame과 탭은 보였지만
section 배치 뒤 provider DOM이 없었습니다. `ui.plugin-view.overlay`는 `registryPresent=true`,
`overlayReason=none`, `mounted=[]`를 반환했습니다. 따라서 이 캡처는 빈 process 결과가 아니라 Core
sidebar host mount RED를 증명합니다. 두 sidebar의 시각 acceptance 전에 section과 `PluginViewHost`
수명 연결을 먼저 고쳐야 합니다.

현재 Core를 다시 빌드하고 새 격리 identity에 monitor 0.0.9을 설치한 뒤 빈 project 상태에서
`No owned processes in this project`가 표시되는 것을 확인했습니다. project root를 cwd로 하는
실제 `process_spawn`를 실행하자 `process.inventory`에 같은 cwd가 반환됐고, focus를 주지 않은
캡처에 `soksak-core`, 명령, pid, project 경로, `running`이 표시됐습니다. 이로써 snapshot
consumer의 project 필터 표시 행은 닫혔지만 PTY shell·자식 프로세스 검증은 아직 남았습니다.

2026-08-30에 격리 테스트 identity에서 최신 arm64 Core와 monitor 0.0.9으로 같은 검사를 반복했습니다.
focus를 주지 않은 캡처에 선택한 project sidebar와
`/bin/sh -c sleep 20`, PID, 정확한 project `cwd`, `running`이 보였습니다. 기계적 관측은
`process.inventory` revision 1의 `soksak-core` record 하나와 monitor refresh의 owner 두 개였습니다.
이는 project root 교집합의 반복 증거이며 PTY 자식 프로세스나 탭 전환 안정성의 증거는 아닙니다.

PTY owner `soksak-sidecar-pty` 0.0.19를 Unix 자식 reader와 working-directory 필드가 포함된
immutable local release로 저장했습니다. arm64 artifact의 local release digest는
`1ab2742ac51d474390397a03543730c8d075992d6f622bc7eb5b0298c513d552` (source `b2e774d`)이며,
기존 0.0.18과 0.0.17은 자동으로 바뀌지 않고 그대로 보존됩니다.

2026-08-30 격리 workspace에 File Tree 0.0.3과 process-monitor 0.0.9을 설치하고 두 view를
하나의 section set으로 조합해 왼쪽 영역에 배치했습니다. 포커스를 주지 않은
캡처에는 `파일`과 `프로세스` tab 및 File Tree 내용이 보였고, process tab에는
`No owned processes in this project`가 표시됐습니다. `ui.plugin-view.overlay`는 두 view를
`ready`로 보고했고 보이는 process view는 `298px × 473px`였습니다. 이는 sidebar 조합과 project
표시를 증명하며 terminal 자식 열거나 tab 전환 안정성을 증명하지 않습니다.

2026-08-30 격리 환경에서 xterm candidate 0.0.64를 설치하자 PTY 0.0.19가 시작되고 prompt도
그려졌지만 status bar에는 선택한 workspace root가 아니라 Core checkout이 표시됐습니다.
이 candidate가 terminal kit 0.0.80을 포함하기 때문입니다. 이는 PTY 소유권 실패가 아니라
terminal과 project `cwd` 연결의 측정된 RED였습니다. kit 수정과 이를 소비한 후속 candidate는
아래에 기록합니다.

kit 0.0.89가 registry에서 해석 가능해진 뒤 xterm candidate를 0.0.65로 다시 빌드했습니다.
격리 테스트 identity에서 PTY 0.0.19와 kit 0.0.89가 선택됐고, terminal status가 선언된 workspace
root를 반환했습니다. 포커스를 주지 않은 캡처에는 prompt, `XTERM_CWD_GREEN` 출력, 같은 workspace
경로 footer가 함께 보였습니다. 이 candidate에서는 앞서 측정한 terminal-project `cwd` RED가
닫혔습니다. selection drag는 별도 gate입니다.

같은 xterm 0.0.65 closure에서 하나의 pane에 terminal tab 두 개를 열고 각 tab에 다른 PTY marker를
출력했습니다. `tab.switchScan threshold=0.0001` 결과는 `clean=true`, `switchFrames=1`,
`flickerFrames=0`이며 blank·overlap·native-mismatch frame은 없었습니다. 포커스를 주지 않은
캡처에는 활성 두 번째 tab, marker 출력, prompt, 선언된 workspace-root footer가 보였습니다. marker가
전체 창에서 차지하는 비율이 작아
threshold를 명시한 것이며 기준을 낮춘 것이 아닙니다.

## 공개 계약

### 모니터링 선택 규칙

모니터는 서로 독립적인 두 사실의 교집합을 사용합니다. `environment.json`은 설치된 owner release를
선택할 뿐 process를 선택하지 않습니다. owner는 권위 있는 `cwd`가 포함된 process record를 공개하고,
선택된 project는 root를 제공합니다. 설치된 owner의 record이면서 `cwd`가 project root와 같거나 그
하위인 경우에만 표시합니다. 터미널이나 sidecar가 process를 열어야 record가 생기며 browser view는
process를 만들지 않습니다. owner를 읽을 수 없는 경우는 unavailable로 보고하고 빈 목록으로 바꾸지
않습니다.

owner snapshot은 처음 읽는 경로이고 owner event stream은 실시간 경로입니다. 둘 다 monotonic revision을
포함하며, revision gap은 새 snapshot이 필요한 관측 실패이지 consumer가 폴링하거나 workstation을
검사해도 된다는 뜻이 아닙니다.

Core는 owner 구현을 읽지 않고 계약 형태만 검증합니다. 모든 record의 `owner`는 이를 감싼
`OwnerInventory.owner`와 같아야 하며, 다르면 계약 오류로 거부합니다. source owner로 조용히
덮어쓰지 않습니다.

process 소유자는 process contract를 통해 다음과 같은 일반 record를 발행한다.

```text
process.inventory -> {
  revision,
  processes: [{
    id, owner, window, pane, pid, parentPid, command, state,
    startedAtUnixMs, endedAtUnixMs?
  }]
}
```

`owner`는 선언된 component identity이고 `window`와 `pane`은 선택적 소유 키이며 `state`는
`running` 또는 `ended`다. source checkout, private socket 경로, 추정한 repository 이름은
record에 넣지 않는다. 소유자는 자신이 시작했거나 명시적으로 연결한 process만 공개한다.
Core aggregator는 주입된 owner interface를 통해 record를 합치며 PTY나 다른 sidecar가 자식
process를 찾는 방법을 알지 않는다.

같은 계약이 `process.started`, `process.updated`, `process.ended` event를 record id와 revision과
함께 발행한다. event가 live update 경로이며 `process.inventory`는 최초 mount와 명시적 읽기에
사용하는 snapshot command다. polling loop로 쓰지 않는다. revision gap은 읽기 실패이지 조용한
재조회 허가가 아니다.

PTY sidecar가 shell과 process group을 소유하므로 자기 public contract를 통해 terminal process
record를 공급한다. Core는 shell output을 해석하지 않고 record를 relay한다. Terminal plugin과
monitor plugin은 일반 process surface만 소비하며 서로의 plugin이나 provider engine을 ID로
결합하지 않는다.

첫 monitor release는 읽기 전용이다. kill command, signal escalation, timeout, fallback 목록을
추가하지 않는다. 나중에 signal 기능이 필요하면 별도 contract와 소유권 증명을 만든다.

## Sidebar 조합

monitor는 `side` surface에 `process-monitor` view 하나를 제공한다. Core의
`sections.create`, `sections.arrange`, `sections.left`, `sections.link`, `sidebar.move`로 File Tree
또는 다른 sidebar와 조합한다. view에는 일반 process snapshot/event와 binding context(`projectId`,
`window`, `pane`)만 전달하며 layout store나 다른 plugin DOM은 읽지 않는다.

## 필요한 RED→GREEN gate

1. Contract test가 owner 없는 record, 소유되지 않은 PID, revision gap을 거부한다.
2. PTY owner test가 shell과 descendant 하나를 안정된 id로 발행하고 process group 종료 때 둘을 제거한다.
3. Core test가 두 fake owner를 합치면서 source를 읽지 않고 소유 필드를 보존한다.
4. Monitor plugin test가 최초 snapshot을 그리고 event를 한 번만 적용하며 stale revision을 거부한다.
5. 설치된 capture-only run에서 terminal을 열고 marker process를 실행해, `process.list`가 Core
   전용이어도 monitor에 shell/process record가 보이는지 확인한다.
6. 유한 recording과 `surface.inventory`로 terminal/browser tab 전환 및 sidebar resize 중에도
   조합된 sidebar가 보이는지 확인한다. Screenshot은 관측 증거이며 단독 판정 근거가 아니다.

여섯 gate가 모두 GREEN이 되기 전에는 process-monitor sidebar를 명시적으로 미구현 capability로
남긴다.

## Vision cwd와 설치 monitor 증거 — 2026-08-30

Native Vision 경로에는 별도 cwd 누락이 있었습니다. Plugin Kit 0.0.99는 pane의 선언된 initial cwd를
`TerminalPresenterOptions`로 전달하고 Vision 0.0.53은 service가 PTY를 열기 전에 public terminal surface
source에 이를 기록합니다. Kit RED에는 cwd가 없었고 GREEN은 exact project root를 받았습니다. Kit 0.0.99는
local Registry와 immutable store에 publish됐고 digest는
`5c5a352f68c9453ea2774dabc1fcdb194fae4683ce3700e64ba3209d8acc7e13`입니다. Vision 0.0.53은
`published` 뒤 `unchanged`, digest `89bf593e5ee2dbc211bfd9ec2a5491eb5e82f14c057bf1e3ff37b4a4f1de0f9c`였습니다.

Process Monitor 0.0.9는 이전 PTY record가 optional `cwd`를 생략하면 crash했습니다. Process Monitor
0.0.10은 그런 record를 project에 귀속하지 않고 exposed view에 `PROCESS_CWD_UNAVAILABLE: <count>`를
게시합니다. 이름 있는 RED는 `undefined.startsWith`로 실패했고 GREEN은 project match 없이 missing field
수를 반환합니다. Immutable release digest는
`0daa9e60ed6b42984985d702fb740fde247593fa6100596c9b61faf724649120`입니다.

격리 설치 제품은 File Tree 0.0.3과 Process Monitor 0.0.10을 한 left section set으로 조합했습니다.
두 view key가 `sections.list`와 `sidebar.tree`에 나타났고 File Tree는 project를 표시했으며 monitor는
`bootPhase=ready`, `overlayReason=none`이었습니다. 새 Vision 0.0.53 terminal은 exact workspace root를
`process.inventory`에 게시했습니다. `sleep 20 &` 실행 뒤 owned shell과 descendant record가 stable ID,
parent PID, command, 같은 cwd, `running`을 보고했고 non-key capture에서 live terminal 옆에 두 record가
보였습니다. 이전에 복원된 session은 explicit missing-cwd count로만 나타났습니다.

설치 snapshot, project filtering, shell, descendant, local Registry, 기본 sidebar composition row는
GREEN입니다. 명시적 `refresh` command는 operator recovery이며 live path가 아닙니다.

## 이벤트 기반 설치 acceptance — 2026-08-30

PTY 0.0.22는 Darwin process-event watcher로 descendant 관측을 소유하고 같은 monotonic owner ledger를
snapshot과 event interface로 공개합니다. Immutable local release digest는
`78611e24e0b8c1989e67b4409a80ecf9105fe4814823873f6a39253d2d236385`입니다. Core source
`81e25abf`는 선언된 PTY unit이 시작될 때 `process.observe`를 구독하고 public
`process.inventory.changed` event를 relay합니다. PTY source tree나 process 구현을 읽지 않습니다.

Process Monitor 0.0.14는 이 event stream을 축약하고 `status`와 event 기반 `wait` command를
공개합니다. `wait`는 owner, 낮은 revision 경계, 선택적인 정확한 process count를 받습니다. 축약된
state로만 완료하며 timer는 polling loop가 아니라 bounded failure deadline입니다. Owner RED에서는
parameter schema를 선언하지 않은 handler가 `INVALID_PARAMS`로 거부됐고, GREEN은 모든 parameter를
public registry에 선언합니다. Immutable release는 `published` 뒤 `unchanged`였으며 digest는
`910d514294b060267347589e73653e9a2c243c9c643d2a865ad9bcead0600d63`입니다.

격리 capture-only 설치의 baseline은 owner revision 8, shell record 4개였습니다. `refresh`를
호출하지 않고 `sleep 60` 하나를 시작하자 revision 9, record 5개에서 `wait`가 완료됐습니다. 같은
PID를 종료하자 다음 `wait`가 revision 10, record 4개에서 완료됐습니다. 두 번째 시작은 revision
11에 도달했고 focus를 주지 않은 native-composed capture에서 terminal 옆에 shell 4개와 owner가
공개한 `sleep 60` descendant가 보였습니다. Cleanup은 revision 12, record 4개에 도달했습니다. 따라서
snapshot, Core relay, plugin reducer, public wait command, rendered row가 같은 owner revision에
합의합니다.

설치 window에서 linked terminal/browser sidebar set도 양방향으로 전환했습니다. 각 방향은 한 frame에
settled됐고 flicker·blank·overlap·native-mismatch frame은 모두 0이었습니다. 이로써 gate 6의 tab
전환 절반은 닫혔습니다. 유한 sidebar resize recording은 여전히 OPEN이며 static capture로
추정하지 않습니다.
