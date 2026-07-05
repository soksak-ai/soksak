# 리사이즈 E2E (기계 측정, GREEN/RED)

빠른 창/디바이더 리사이즈에서 ① 본문 blank ② 프롬프트 잘림 ③ TUI 스테일 회귀를
**사람·AI 개입 없이** 기계로 판정한다. `panel.resize` 명령으로 빠른 드래그와 동일 경로
(resizeSplit → 렌더 → fit + PTY)를 구동하고, 터미널 버퍼(term.read)를 분석해 명확한
임계로 PASS/FAIL 한다(본문 blank 판정만 opt-in 화면 녹화 사용). 전용 워크스페이스 창
(w-*)에서만 동작한다 — `main` 은 컨트롤 플레인이라 창을 지정하지 않으면 측정이 무효다.

## 실행

```bash
# 대화형(TTY): 동의 프롬프트 후 진행
make e2e-resize                      # IDENTITY 기본 dev

# 비대화형(CI/스크립트): 동의를 환경변수로
E2E_CONSENT=1 scripts/e2e/resize.sh --identity dev
```

종료코드: `0`=GREEN(전 기준 통과), `1`=RED(회귀), `2`=실행 안 함(동의 없음/환경 미비).

## 검증 항목과 기준(명확·결정적)

| id | 검증 | 측정 | GREEN 기준 |
|---|---|---|---|
| T1 | 본문 blank 없음 | 빠른 디바이더 드래그 녹화 → 좌패널 본문 프레임별 내용 비율 | 최장 연속 blank 프레임 `maxRun ≤ 3` |
| T2 | 프롬프트 무결 | 드래그(시작=끝 폭) 후 양 패널 마지막 줄 `term.read` | 마지막 줄(trim) `== 마커` (양쪽) |
| T3 | TUI 추종 | TUI(alt screen)에 빠른 드래그 + 넓힘→좁힘 | blank `maxRun ≤ 3` **그리고** TUIDIM cols 가 넓힘>좁힘으로 감소 |

- **blank 정의**: 본문 영역의 "내용 비율"(배경과 다른 픽셀 비율)이
  `max(3%, baseline×0.30)` 미만인 프레임. baseline=전체 프레임 중앙값.
  회귀 버전은 수십 프레임 연속 blank(maxRun 30~50+), 수정 버전은 0~1 전환만 →
  임계 3 은 충분한 마진.
- **프롬프트 마커**: `E2EMARK_0123456789_ABCDEFGHIJ_END`(33자). 좁은 극단에서
  래핑될 만큼 길고, 시작=끝(net-zero) 폭이라 "SIGWINCH 미전달이면 영영 안 고쳐지는"
  worst case 를 친다. 수정(드래그 중 라이브 SIGWINCH)에서만 무결.
- **TUI 추종**: TUI 가 SIGWINCH 마다 재그린 cols 가 폭 변화를 따라가는지로
  스테일/lag 회귀를 잡는다(20Hz 라이브 SIGWINCH 가 TUI 를 망가뜨리지 않는지 — 우려 검증).

## 전제

- **macOS 전용**(현재): 합성 입력(CGEvent)·영상(screencapture)·창 좌표(AX)가
  macOS API. 타 플랫폼에선 RED 가 아니라 **SKIP**(종료 0) — 각 OS 입력/캡처 백엔드가
  생기면 동일 판정 로직을 이식한다.
- **앱 실행 중 + 창 가시**: 백그라운드 WKWebView 는 이벤트 루프가 스로틀되어 측정 무효
  (하니스가 자동 전면 활성화).
- **손쉬운 사용(Accessibility) 권한**: 터미널 앱에 1회 허용(없으면 RED — 좌표/입력 불가).
- **사용자 동의(필수)**: 합성 입력이 ~10초간 마우스를 점유한다. 동의 없이는 실행하지
  않는다(대화형 프롬프트 또는 `E2E_CONSENT=1`). 그동안 **마우스/키보드를 만지지 말 것** —
  실제 입력이 섞이면 측정이 오염된다.
- 도구: `node ffmpeg python3(pillow) screencapture swiftc`.

## 구성

- `resize.sh` — 오케스트레이터(플랫폼·동의·환경 게이트 → 셋업 → 측정 → 판정 → 정리).
- `e2e-driver.mjs` — sok 소켓 RPC: resize-e2e 프로젝트 셋업·디바이더 좌표(ui.measure)·
  결정적 프롬프트·버퍼 읽기·분할 비율·정리.
- `analyze-blank.py` — 영상 → 본문 blank 프레임 기계 측정(ffmpeg+PIL).
- `tui-probe.sh` — 결정적 TUI(WINCH 재그리기, 마지막 줄 `TUIDIM=CxL` 마커).
- `../perf/synth-input.swift` — CGEvent 합성(`osc` 연속 왕복 드래그 포함, perf 와 공유).

## 회귀 재현(수동 참고)

기준이 실제 버그를 잡는지 보려면, 수정 이전 동작으로 되돌린 뒤(예: createTerminal 의
fit 스로틀 제거 → 매 프레임 fit, 또는 PTY 라이브 SIGWINCH 제거) 같은 명령을 돌리면
T1 maxRun 이 수십으로, T2 마커가 잘려 RED 가 떠야 한다.

---

# 플러그인 E2E 는 각 플러그인 repo 가 소유한다

플러그인 전용 E2E 시나리오는 코어가 아니라 **해당 플러그인 repo** 에 둔다(분리 원칙 — 코어는
플러그인 전용 테스트를 담지 않는다). 코어 `scripts/e2e/` 는 코어 기능(리사이즈·멀티윈도우 등)만.

- soksak-plugin-claude-gui → `e2e/claude-gui.mjs` (그 repo)
- soksak-plugin-mailbox → `e2e/mailbox.mjs` (그 repo)

각 시나리오는 소켓 RPC(JSON-RPC) 로 실행 중인 코어 앱을 구동·단언하므로 코어 의존성 없이
플러그인 repo 안에서 독립 실행된다. 아래 방법론은 플러그인·코어 공통.

# E2E 작성 방법론

E2E 하니스·테스트 표준(멱등 시나리오, introspection 우선, 결정적/LLM 분리, 실측 시그니처,
하니스 규칙)의 정본은 **[docs/TESTING.md](../../docs/TESTING.md)** 다. 이 README 는 리사이즈
하니스의 검증 항목·기준·구성만 다룬다.
