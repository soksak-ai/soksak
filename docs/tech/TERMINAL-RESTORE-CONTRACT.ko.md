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

## 입력 준비 상태

Kit 0.0.90은 byte renderer의 `attach` 직후 `writable=false`를 유지하고 첫 PTY output이 renderer에
적용된 event에서만 `writable=true`로 전환합니다. Warm 복원은 attach 전에 authoritative frame을 이미
적용했으므로 즉시 입력 가능합니다. 이 규칙은 timer나 polling 없이 fresh prompt와 첫 입력의 순서를
고정합니다.
