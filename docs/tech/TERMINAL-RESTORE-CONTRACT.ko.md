# 터미널 복원 계약

복원은 깨끗한 터미널을 다시 만드는 일이 아니라 세션을 이어가는 일입니다.

## 필수 순서

1. 저장된 workspace 레이아웃과 pane identity를 hydrate합니다.
2. 저장된 PTY 세션을 찾고, PTY가 없으면 보관된 checkpoint를 찾습니다.
3. renderer를 붙이기 전에 실제 pane 크기를 기다립니다.
4. 정확한 output sequence를 포함한 authoritative frame/snapshot 하나를 적용합니다.
5. renderer lease를 기존 PTY 세션에 연결하고 그 sequence 이후 바이트만 전달합니다.
6. renderer가 frame을 적용하고 input owner가 writable이 된 뒤에만 `ready`를 게시합니다.

PTY가 셸의 연속성과 scrollback을 소유하고 renderer가 그려진 viewport를 소유합니다. 따라서 복원된
화면에 이전 명령과 의도적인 빈 줄이 보일 수 있습니다. 이는 셸이 중복된 증거가 아니라 같은 세션의
증거입니다. `terminal.clear`는 engine 화면을 지우지만 셸 프로세스나 daemon history를 지우지 않습니다.

## 소유권과 순서

| 항목 | Workspace 복원 | Terminal Kit 복원 |
|---|---|---|
| 레이아웃 | tab, pane tree, focus, pane-세션 매핑 hydrate | pane tree, focus, engine, title, CWD hydrate |
| 세션 소유권 | pane mount 전에 저장된 PTY id를 reconnect plan으로 게시 | `pty.pane`로 소유권 확인 후 `terminal.rehydrate`가 lease 발급 |
| 첫 화면 | manager mount와 사용 가능한 크기를 기다림 | `ready` 전에 정확한 `frame`/snapshot 적용 |
| 라이브 연속 | checkpoint sequence 뒤 daemon stream 재개 | `uptoSeq` 뒤 `pty.attachLease` 재개 |
| 종료된 세션 | unavailable/reconnect 상태를 명시 | archived frame 표시 후 새 셸을 열고 결과를 표시 |
| 입력 준비 | 복원 pane 준비 완료 뒤 입력 probe | lease/open 성공 뒤 `attach`에서만 `writable=true` |

sequence 없는 캐시 문자열을 그리거나, 소유된 pane에 두 번째 셸을 열거나, ready 전에 입력을 받으면
RED입니다. 화면 캡처만으로는 이 계약을 인증할 수 없으며 recovery/status sequence와 독립 입력 marker를
함께 확인해야 합니다.

## 뒤에 프로세스가 없는 화면

restore 는 화면을 돌려주며 그것을 그린 프로그램은 결코 돌려주지 않습니다. 이유는 `SESSION.md` S6-2 에
있습니다. 프로세스를 복원하려면 이 애플리케이션이 대상으로 하는 어느 플랫폼도 제공하지 않는 커널
checkpoint 이거나, host 플랫폼이 서드파티에게 주지 않는 entitlement 뒤의 머신 스냅샷이 필요합니다.
돌아오는 것은 저장된 출력과 새 shell 입니다.

**그런 화면은 history 로 제시합니다.** alternate screen 은 text flow 로 flatten 되고, 사람은 실행됐던
프로그램의 기록을 읽습니다.

3일 전에 끝난 프로세스 위에 전체 화면 편집기를 살아 있는 것처럼 그리는 것은 거짓을 명시합니다. 그
화면은 shell 로 가는 키를 받으면서 자신으로서는 아무것도 응답하지 않습니다. 그렇게 제시하면 restore 는
복구가 아니라 오표시가 됩니다.

flatten 은 제시 시점에 적용합니다. 그 시점에 판정 근거가 알려져 있기 때문입니다. 화면 뒤에 프로세스가
있는지입니다. 있으면 같은 재생이 화면을 살아 있는 채로 세우며, 그 경우가
[`COMPONENT-HANDOFF.md`](COMPONENT-HANDOFF.md) 의 프로세스 교체입니다.

이 규칙은 `SESSION.md` 가 아니라 여기서 판정됩니다. 판정 대상 컴포넌트가 미러이고 미러는 session 을
소유하지 않기 때문입니다. session 문서의 일은 소유자가 무엇을 돌려주는지에서 끝납니다.

## 입력 준비 상태

Kit 0.0.91은 byte renderer의 `attach` 직후 `writable=false`를 유지하고 첫 PTY output이 renderer에
적용된 event에서만 `writable=true`로 전환합니다. Warm 복원은 attach 전에 authoritative frame을 이미
적용했으므로 즉시 입력 가능합니다. 이 규칙은 timer나 polling 없이 fresh prompt와 첫 입력의 순서를
고정합니다.

Kit 0.0.91과 xterm Plugin 0.0.68의 설치 런타임 검사도 같은 규칙을 증명했습니다. Fresh mount는
accepted-input과 PTY-write sequence가 모두 0인 상태에서 한 frame을 먼저 렌더했습니다. 공개 key event
32회는 accepted input 32회와 write 32회를 만들고 marker와 prompt를 표시했습니다. 앱 재시작 뒤 pane은
`recoveryOutcome=continued`와 첫 marker를 유지했고, 공개 key event 30회는 accepted input 30회와 write
30회를 만들고 두 번째 marker와 prompt를 표시했습니다.

## 선택과 스크롤 증거

공개 drag 경로는 primary button 단일 click과 document 소유 move/release event를 전달합니다. 격리
runtime에서 렌더된 `SELECT_ME_1234567890` marker를 drag하자 `selection`, `copy`, 독립적인
`clipboard.read`가 같은 20자를 반환했습니다.

Contract 0.0.19, Kit 0.0.93, xterm Plugin 0.0.70은 viewport 소유 상태를 관측 가능하게 합니다.
offset 0은 `follow`, 양수 offset은 `pinned`입니다. history 85행에서 설치 runtime은
`0/85 follow`를 보고했고, 공개 10행 scroll은 `10/85 pinned`를 반환하고 status에도 게시했으며,
공개 bottom scroll은 `0/85 follow`를 반환하고 게시했습니다. pinned capture에는 43~71행이,
bottom capture에는 52~80행과 prompt가 보였습니다. command 응답, status, pixel이 같은 viewport
상태를 설명합니다.

registry에서 소비되는 계약 릴리스는 공개 export로 도달 가능한 모든 파일을 봉인해야 합니다.
0.0.18 artifact는 `src/pane-key.ts`를 누락해 첫 Kit 소비 build에서 실패했으며 그대로 불변입니다.
Contract 0.0.19는 누락 파일과 repository boundary test를 추가했고 consumer build는 GREEN입니다.
