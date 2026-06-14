# 리사이즈 E2E (기계 측정, GREEN/RED)

빠른 창/디바이더 리사이즈에서 ① 본문 blank ② 프롬프트 잘림 ③ TUI 스테일 회귀를
**사람·AI 개입 없이** 기계로 판정한다. 합성 입력(CGEvent)으로 빠른 드래그를 만들고,
영상(screencapture)·터미널 버퍼(term.read)를 분석해 명확한 임계로 PASS/FAIL 한다.

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

# claude-gui E2E (`claude-gui.mjs`)

soksak-claude-gui 플러그인(입력 3계층 큐·대화 렌더·persistence·라이브)을 실제 앱에서 멱등 검증.

```bash
SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/claude-gui.mjs [paneId]
# 전제: 대상 pane 에 claude 실행 중(없으면 자동 시작). 스냅샷 → /tmp/sok-e2e-claude-gui
```

소켓 RPC + 플러그인 introspection·구동 명령(`plugin.soksak-claude-gui.state/send/focus/type/queue`)
으로 단언. `focus`=GUI 입력창 포커스(화면 이동), `type`=입력창에 진짜 타이핑+Enter(우회 없는 입력 경로).
종료코드 0=결정적 PASS, 1=FAIL. `E2E_ONLY=<scenario[,...]>` 로 일부만 실행. 시나리오:

| # | 검증 | 결정성 |
|---|---|---|
| 1 | 모달(/status) 중 입력 → held(다이얼로그 대기), claude 미주입 | 결정적 |
| 2 | 모달 닫힘 → FIFO 드레인 → L3(claude 처리) 후 큐 제거 | claude 응답 의존(타임아웃 SKIP) |
| 3 | persistence — GUI 닫았다 열어도 큐 항목 보존 | 결정적 |
| 4 | 대화 렌더 — JSONL → 버블 N개 + 세션 식별 | 결정적(히스토리 전제) |
| 5 | 라이브 응답 밴드(.cg-live) | claude 응답 의존(재시도+안전대기, SKIP 허용) |
| 6 | /resume 세션 동기화 — 통제 fixture(알려진 Q&A 세션 /clear 생성) → 피커 settle+DOWN+Enter → GUI 가 그 세션으로 전환(state.session==newest jsonl) → 입력창 type 입력이 그 세션 도달+렌더 | 결정적(자체 fixture·멱등), 피커 미등장/취소 SKIP |

## 방법론 (테스트 설계 원칙)

이 하니스를 만들며 확정한 원칙 — 새 기능 e2e 시 따른다:

1. **일회성 명령 금지.** ad-hoc `sok` 호출로 한 번 확인하면 재현·개선이 안 된다. 반드시
   setup→단언→teardown 의 **멱등 시나리오 파일**로 남긴다(이 디렉토리).

2. **CLI/소켓에 안 노출돼 테스트 불가하면 거부하지 말고 인터페이스를 만든다.** DOM 등 소켓이
   못 보는 상태는 대상 컴포넌트에 introspection 명령을 추가(예: `plugin.*.state` →
   `{open,bubbles,live,queue,classify}`)하고 — 매니페스트 선언·`docs/COMMANDS.md`(자동 생성)·
   `docs/PLUGINS.md`·플러그인 README 등 **부대 문서를 함께 갱신**한다. 명령은 레지스트리
   단일원천이라 CLI·MCP 에 자동 노출된다.

3. **결정적 단언과 LLM-응답 의존을 분리한다.** claude/TUI 의 응답 시작·시간은 LLM thinking·
   컨디션에 따라 불가측(실측상 0~수십초 지연, 응답 트리거 자체가 누락되기도). 따라서:
   - 상태·큐·렌더·classify 같은 **결정적** 부분은 hard 단언(FAIL 시 종료 1).
   - 드레인·라이브 같은 **응답 의존** 부분은 **재시도(Nx) + 안전대기(고정 타임아웃 대신
     조건 기반 폴링) + SKIP 허용**. 대기시간만 늘리는 건 답이 아니다 — 재시도가 정도.
   - 로직 자체는 **단위테스트**로 못박고(예: `parseLiveResponse`), e2e 는 통합만 확인한다.

4. **시그니처는 실측으로 확정한다.** 버퍼 시그니처(모달 `Esc to cancel`, 응답중 스피너 등)는
   추정 금지 — 소켓 `term.read` 로 실제 버퍼를 읽어 RED fixture 로 고정한 뒤 구현·정정한다.
