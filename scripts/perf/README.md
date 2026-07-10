# 퍼포먼스 하니스 (멱등 E2E)

상호작용 성능을 기계적으로 측정한다. 매 실행마다 동일한 레이아웃을 재구성하고
(`perf-harness` 프로젝트 — 끝나면 제거), 시나리오를 구동하며 대상 앱의 프로세스
CPU(앱 메인 + 귀속 WebKit XPC 합산)를 샘플링해 JSON/표로 보고한다.

두 갈래:
- **s 시나리오**(`run.sh`) — 상호작용(리사이즈/이동/스크롤) 성능. 일부는 입력 합성 필요.
- **t 시나리오**(`run-t.sh`) — 터미널 성능(W4)·예산 게이트. 전부 소켓 하니스(권한 불요).

## 실행

```bash
# 전체 시나리오, debug 인스턴스(앱이 떠 있어야 함)
scripts/perf/run.sh --identity debug --label baseline

# 일부만 + 베이스라인 비교
scripts/perf/run.sh --identity debug --scenarios s1,s7 \
  --baseline scripts/perf/results/<기준>.json

# 터미널 성능 + 예산 게이트(budgets.json 위반 시 exit 1)
make perf-gate                 # = 게이트 자체검증 + run-t.sh --identity debug --t1mb 100
scripts/perf/run-t.sh --identity debug --label baseline --no-gate   # 리포트만
```

- `--identity debug|dev|release` — 대상 인스턴스(소켓: `~/.soksak/com.soksak.*.sock`)
- `--keep` — 종료 후 perf-harness 프로젝트를 남김(수동 검사용)
- 결과: `scripts/perf/results/<ts>-<label>-<identity>.json`

## t 시나리오 (터미널 성능 — W4)

| id | 내용 | 측정 채널 |
|---|---|---|
| t1_plain / t1_ansi | 처리량: 고정 픽스처(100MB, `~/.soksak-e2e/perf/fixtures` 자동 생성) `cat` | `terminal.command.started/finished` 활동 이벤트 ts(`events.subscribe` push — 폴링 0) + `perf.stats` 카운터 차분 + 구간 CPU |
| t2 | 입력 레이턴시 L1: 왕복 50회 통계 | 터미널 플러그인 `perf.echo`(측정점 = 플러그인 write→PTY 에코→onData 도착. 소켓 RPC·페인트 제외 — 페인트 포함 축은 `perf.stats` 의 writeCbLagMs/rafFrameCount) |
| t5 | 유휴 CPU(10s) | CPU 샘플러(앱 전체) |
| t6 | 메모리 | PID 군 RSS 합 |

기본 순서는 콜드→부하(t5,t6,t2 → t1). **t5/t6 은 앱 전체(열린 창 전부) 측정**이라
리포트 `meta.windowsOpen` 이 다르면 비교 무효 — budgets.json 의 조건 기록을 따른다.

### 예산 게이트(budgets.json)

- 초기값은 **첫 실측에서 유도**한다(수치 선긋기 금지) — `meta.baseline` 에 실측 원값,
  `meta.headroom` 에 유도 계수를 명기한다. 갱신은 새 실측 + 조건 기록과 함께 커밋.
- `check-budgets.mjs <report> [budgets]` — 위반 전부 열거 후 exit 1. 예산에 있는 지표가
  리포트에 없으면 MISSING 위반(시나리오 무언 탈락 방지).
- 게이트 자체는 `check-budgets.test.mjs`(vitest — `make verify` 의 test-front 에도 포함)가
  검증한다 — `make perf-gate` 가 실측 전에 먼저 돌린다.
- 이 게이트가 ptyd 등 터미널 데이터 경로 수술의 회귀 감지망이다(W4→W5 순서 강제).

### PR 밖 스케일 런

비싼 스케일 런은 PR 게이트에 넣지 않는다(플랜 W4): t1 대형(>100MB)·t7 다중 pane
간섭 매트릭스(4·8·16)는 일일 크론(W4 M4, macOS runner)·로컬 수동 실행으로 돌린다.
합성입력 필요분(t3 스크롤 등)은 macOS 로컬 명령 유지(`run.sh` s5/s6 계열).

## 시나리오

| id | 내용 | 구동 방식 |
|---|---|---|
| s1 | 디바이더 리사이즈 스톰(90Hz×5s, 실드래그와 동일 경로) | sok 소켓(파이프라인) |
| s2 | 뷰 이동(드롭) 왕복(20Hz×5s) | sok 소켓 |
| s3 | 사이드바 폭 드래그(5s, 베스트에포트 좌표) | CGEvent 입력 합성 |
| s4 | 창 리사이즈 왕복 드래그(5s) | CGEvent 입력 합성 |
| s5 | 에디터(CodeMirror) 스크롤(5s) | CGEvent 입력 합성 |
| s6 | 파일트리 스크롤(5s) | CGEvent 입력 합성 |
| s7 | 유휴(10s) | — |

각 시나리오는 **본구간(active)** 과 **테일(tail, 종료 후 8s)** 을 분리 측정한다.
테일은 "상호작용이 끝나고 몇 초 뒤 CPU가 더 오른다"는 지연 스파이크(예:
SIGWINCH 폭주 → TUI 연쇄 재그리기)를 포착한다.

## 전제

- 대상 앱 실행 중 + **창이 화면에 보여야 함** (백그라운드 WKWebView 는 이벤트
  루프가 스로틀되어 측정 무효 — run.sh 가 자동으로 전면 활성화한다. 검증:
  비활성 RTT 300ms+ ↔ 활성 2.4ms)
- s3~s6: 터미널 앱에 손쉬운 사용(Accessibility) 권한 필요(없으면 자동 스킵)
- s3/s5/s6 좌표는 창 프레임 기준 근사값 — 빗나가면 무해한 no-op. 화면을 보면서
  실제로 움직이는지 확인할 것
- 측정 중 다른 무거운 작업(빌드 등) 금지 — 수치 오염

## 구성

- `driver.mjs` — 소켓(JSON-RPC) 직결 드라이버: setup/s1/s2/teardown/ping/tree
- `synth-input.swift` — CGEvent 마우스 드래그/스크롤 합성 + 창 프레임 조회
- `lib.sh` — 대상 PID 탐색(lsof 로 WebKit XPC 귀속) + CPU 샘플러
- `run.sh` — 오케스트레이터(셋업→시나리오→리포트→정리)
