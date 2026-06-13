#!/bin/bash
# 리사이즈 E2E (기계 측정, GREEN/RED) — 사람·AI 개입 없이 panel.resize "스톰"으로
# 빠른 리사이즈를 구동하고, 터미널 버퍼/영상을 기계 분석해 회귀를 판정한다.
#
# 왜 명령 구동(합성 마우스 아님): panel.resize 는 실제 디바이더 드래그와 동일 경로
# (resizeSplit → 렌더 → ResizeObserver → fit + PTY)를 타지만, 멱등·결정적이고
# 손쉬운 사용 권한·GUI 세션이 불필요하며, 사용자 마우스와 절대 충돌하지 않는다.
# 버그는 fit/PTY 경로에 있지 OS 창 상호작용에 있지 않으므로 마우스는 불필요하다.
#
# 검증 항목(명확한 임계):
#   자기검증  리사이즈가 실제로 cols 를 바꾸는가(거짓 GREEN 방지 — 안 바뀌면 RED).
#   T1 blank  빠른 리사이즈 중 본문이 통째로 비지 않음(최장 연속 blank ≤ 임계).
#             영상 분석 필요 → macOS + 화면 녹화 동의(E2E_RECORD=1)일 때만, 아니면 SKIP.
#   T2 prompt 드래그(시작=끝 폭) 후 셸 프롬프트가 잘리지 않음(마지막 줄 == 마커). 영상 불요.
#   T3 TUI    TUI(alt screen)가 빠른 리사이즈 후 폭 변화를 정확히 추종(cols 감소). 영상 불요.
#
# 전제: 앱 실행 중 + 창 가시(전면). T2/T3 는 소켓만으로 동작(크로스플랫폼 잠재).
#       T1 은 macOS 화면 녹화 전용(opt-in).
#
# 사용:  scripts/e2e/resize.sh --identity dev            # T1 SKIP(기본)
#        E2E_RECORD=1 scripts/e2e/resize.sh --identity dev  # T1 포함(macOS, 화면 녹화)
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../perf/lib.sh
source "$E2E_DIR/../perf/lib.sh"
set +e # 개별 단언은 직접 처리(전체 리포트).

IDENTITY="dev"
MAX_BLANK_RUN=3 # 정상=0~1(전환), 버그=수십. 명확한 마진.
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

SOCK="$(identity_socket "$IDENTITY")" || exit 2
[ -S "$SOCK" ] || { echo "RED: 소켓 없음(앱 실행 중?): $SOCK" >&2; exit 1; }
export SOKSAK_SOCKET="$SOCK"
APP="$(identity_app_name "$IDENTITY")"
DRIVER="$E2E_DIR/e2e-driver.mjs"
ANALYZE="$E2E_DIR/analyze-blank.py"
MARKER="E2EMARK_0123456789_ABCDEFGHIJ_END"

command -v node >/dev/null || { echo "RED: node 없음" >&2; exit 1; }

# 앱 전면 활성화(백그라운드 WKWebView 는 이벤트 루프 스로틀로 측정 무효).
osascript -e "tell application \"System Events\" to set frontmost of (first process whose name contains \"$APP\") to true" 2>/dev/null
sleep 0.8

# T1(blank) 가용성: macOS + 화면 녹화 동의 + 도구 + 창 좌표(AX 읽기, 마우스 무관).
RECORD_OK=0
WX=0; WY=0; WW=0; WH=0
SYNTH="$E2E_DIR/../perf/.build/synth-input"
if [ "${E2E_RECORD:-0}" = "1" ] && [ "$(uname)" = "Darwin" ] \
  && command -v ffmpeg >/dev/null && command -v screencapture >/dev/null \
  && python3 -c "import PIL" 2>/dev/null; then
  # 창 프레임(AX 읽기 전용 — 입력 합성 아님). synth-input 빌드(멱등).
  if [ ! -x "$SYNTH" ] && command -v swiftc >/dev/null; then
    mkdir -p "$E2E_DIR/../perf/.build"
    swiftc -O "$E2E_DIR/../perf/synth-input.swift" -o "$SYNTH" 2>/dev/null
  fi
  WB="$("$SYNTH" winbounds "$APP" 2>/dev/null)"
  if [ -n "$WB" ]; then
    WX=$(echo "$WB" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['x']))")
    WY=$(echo "$WB" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['y']))")
    WW=$(echo "$WB" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['w']))")
    WH=$(echo "$WB" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['h']))")
    RECORD_OK=1
  fi
fi

PASS=0; FAIL=0
ok()  { echo "  GREEN: $1"; PASS=$((PASS+1)); }
bad() { echo "  RED:   $1"; FAIL=$((FAIL+1)); }

# 스톰 + 녹화 동시. $1=video lo hi sec. blank 분석 JSON 을 stdout. (좌패널 본문 crop)
record_storm() {
  local video="$1" lo="$2" hi="$3" sec="$4"
  rm -f "$video"
  screencapture -v -V$((sec + 1)) -R"$WX","$WY","$WW","$WH" "$video" >/dev/null 2>&1 &
  local rec=$!
  sleep 0.5
  node "$DRIVER" storm "$lo" "$hi" "$sec" 90 >/dev/null 2>&1
  sleep 0.3
  wait "$rec" 2>/dev/null
  # 좌패널 본문(녹화=창 전체): x 0.22~0.40(사이드바 우측, 0.30 스톰에서도 좌패널 내부),
  # y 0.16~0.90.
  python3 "$ANALYZE" "$video" 0.22 0.16 0.40 0.90
}
trim() { python3 -c "import sys;print(sys.stdin.read().strip())"; }

# ── 셋업 ─────────────────────────────────────────────────────────────────────
echo "── setup(resize-e2e: 좌|우 터미널, 명령 구동) ──"
IDS="$(node "$DRIVER" setup "$REPO_ROOT")" || { echo "RED: setup 실패: $IDS" >&2; exit 1; }
PL=$(echo "$IDS" | python3 -c "import json,sys;print(json.load(sys.stdin)['paneLeft'])")
PR=$(echo "$IDS" | python3 -c "import json,sys;print(json.load(sys.stdin)['paneRight'])")
echo "  panes: L=$PL R=$PR  (record=$RECORD_OK)"
trap 'node "$DRIVER" teardown >/dev/null 2>&1' EXIT
TMP="$(mktemp -d)"; trap 'node "$DRIVER" teardown >/dev/null 2>&1; rm -rf "$TMP"' EXIT

# ── 자기검증: 리사이즈가 실제로 cols 를 바꾸는가(거짓 GREEN 방지) ─────────────
echo "── 자기검증(리사이즈 유효성) ──"
node "$DRIVER" resize 0.2 >/dev/null 2>&1; CN=$(node "$DRIVER" cols "$PL")
node "$DRIVER" resize 0.8 >/dev/null 2>&1; CW=$(node "$DRIVER" cols "$PL")
echo "  좌패널 cols: 좁게(0.2)=$CN  넓게(0.8)=$CW"
if [ "$CN" -gt 0 ] 2>/dev/null && [ "$CW" -gt "$CN" ] 2>/dev/null; then
  ok "자기검증: 리사이즈가 cols 를 구동($CN→$CW) — 측정 유효"
else
  bad "자기검증: cols 불변/무효(narrow=$CN wide=$CW) — 패널 미표시? 측정 무효, 이하 결과 신뢰 불가"
  echo ""
  echo "## 리사이즈 E2E 결과: GREEN=$PASS RED=$FAIL (자기검증 실패 — 중단)"
  exit 1
fi
node "$DRIVER" resize 0.5 >/dev/null 2>&1

# ── T2: 프롬프트 무결(깊은 narrow 스톰, 영상 불요) ───────────────────────────
echo "── T2 프롬프트 무결(명령 스톰, term.read) ──"
node "$DRIVER" prep "$PL" "$MARKER " >/dev/null 2>&1
node "$DRIVER" prep "$PR" "$MARKER " >/dev/null 2>&1
sleep 1.0
node "$DRIVER" storm 0.12 0.88 2.5 90 >/dev/null 2>&1 # 깊은 narrow → 프롬프트 래핑 유발, 시작=끝
sleep 0.5
PLLINE="$(node "$DRIVER" read "$PL" 1 | trim)"
PRLINE="$(node "$DRIVER" read "$PR" 1 | trim)"
[ "$PLLINE" = "$MARKER" ] && ok "T2 프롬프트(L): 무결" || bad "T2 프롬프트(L): 잘림 (기대=$MARKER, 실제=$PLLINE)"
[ "$PRLINE" = "$MARKER" ] && ok "T2 프롬프트(R): 무결" || bad "T2 프롬프트(R): 잘림 (기대=$MARKER, 실제=$PRLINE)"

# ── T3: TUI 추종(영상 불요) + blank(record_ok 일 때) ─────────────────────────
echo "── T3 TUI(alt screen) 추종 ──"
node "$DRIVER" resize 0.5 >/dev/null 2>&1
node "$DRIVER" prep-tui "$PL" >/dev/null 2>&1
sleep 1.2
if [ "$RECORD_OK" = 1 ]; then
  TBLANK="$(record_storm "$TMP/t3.mov" 0.30 0.70 2)"
  echo "  blank(TUI): $TBLANK"
  TMR=$(echo "$TBLANK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('maxRun',999))" 2>/dev/null || echo 999)
  [ "$TMR" -le "$MAX_BLANK_RUN" ] 2>/dev/null && ok "T3 blank(TUI): 최장 연속 blank=$TMR ≤ $MAX_BLANK_RUN" || bad "T3 blank(TUI): 최장 연속 blank=$TMR > $MAX_BLANK_RUN"
else
  node "$DRIVER" storm 0.30 0.70 2 90 >/dev/null 2>&1
fi
# 폭 추종: 넓힘(0.7)→좁힘(0.3) 시 TUIDIM cols 감소(SIGWINCH 전달+재그리기).
node "$DRIVER" resize 0.7 >/dev/null 2>&1
CWIDE=$(node "$DRIVER" read "$PL" 1 | python3 -c "import sys,re;m=re.search(r'TUIDIM=(\d+)x',sys.stdin.read());print(m.group(1) if m else -1)")
node "$DRIVER" resize 0.3 >/dev/null 2>&1
CNARROW=$(node "$DRIVER" read "$PL" 1 | python3 -c "import sys,re;m=re.search(r'TUIDIM=(\d+)x',sys.stdin.read());print(m.group(1) if m else -1)")
echo "  TUIDIM cols: wide(0.7)=$CWIDE  narrow(0.3)=$CNARROW"
if [ "$CWIDE" -gt 0 ] 2>/dev/null && [ "$CNARROW" -gt 0 ] 2>/dev/null && [ "$CNARROW" -lt "$CWIDE" ] 2>/dev/null; then
  ok "T3 TUI 추종: cols $CWIDE→$CNARROW 감소(SIGWINCH 전달·재그리기 정상)"
else
  bad "T3 TUI 추종: cols wide=$CWIDE narrow=$CNARROW (추종 실패/스테일)"
fi

# ── T1: blank(opt-in 녹화) ───────────────────────────────────────────────────
echo "── T1 본문 blank ──"
if [ "$RECORD_OK" = 1 ]; then
  node "$DRIVER" resize 0.5 >/dev/null 2>&1
  node "$DRIVER" prep "$PL" "$MARKER " >/dev/null 2>&1
  sleep 1.0
  BLANK="$(record_storm "$TMP/t1.mov" 0.30 0.70 2)"
  echo "  blank: $BLANK"
  MR=$(echo "$BLANK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('maxRun',999))" 2>/dev/null || echo 999)
  [ "$MR" -le "$MAX_BLANK_RUN" ] 2>/dev/null && ok "T1 blank: 최장 연속 blank=$MR ≤ $MAX_BLANK_RUN" || bad "T1 blank: 최장 연속 blank=$MR > $MAX_BLANK_RUN (본문이 비었다)"
else
  echo "  SKIP: 화면 녹화 미사용(E2E_RECORD=1 + macOS 로 활성화). T2/T3 가 동일 경로를 기계 검증함."
fi

# ── 리포트 ───────────────────────────────────────────────────────────────────
echo ""
echo "## 리사이즈 E2E 결과: GREEN=$PASS  RED=$FAIL"
[ "$FAIL" -eq 0 ] && { echo "GREEN — 모든 기준 통과."; exit 0; } || { echo "RED — 회귀 발견."; exit 1; }
