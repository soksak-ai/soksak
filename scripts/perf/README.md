# 퍼포먼스 하니스 (멱등 E2E)

상호작용 성능을 기계적으로 측정한다. 매 실행마다 동일한 레이아웃을 재구성하고
(`perf-harness` 프로젝트 — 끝나면 제거), 시나리오를 구동하며 대상 앱의 프로세스
CPU(앱 메인 + 귀속 WebKit XPC 합산)를 샘플링해 JSON/표로 보고한다.

## 실행

```bash
# 전체 시나리오, debug 인스턴스(앱이 떠 있어야 함)
scripts/perf/run.sh --identity debug --label baseline

# 일부만 + 베이스라인 비교
scripts/perf/run.sh --identity debug --scenarios s1,s7 \
  --baseline scripts/perf/results/<기준>.json
```

- `--identity debug|dev|release` — 대상 인스턴스(소켓: `~/.soksak/com.soksak.*.sock`)
- `--keep` — 종료 후 perf-harness 프로젝트를 남김(수동 검사용)
- 결과: `scripts/perf/results/<ts>-<label>-<identity>.json`

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
