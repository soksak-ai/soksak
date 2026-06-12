#!/bin/bash
# 퍼포먼스 하니스 오케스트레이터 — 멱등 레이아웃 셋업 → 시나리오 구동 + CPU 샘플링
# → JSON/표 리포트(+ 베이스라인 비교).
#
# 사용:
#   scripts/perf/run.sh --identity debug [--scenarios s1,s2,s5,s6,s7] \
#     [--label baseline] [--baseline scripts/perf/results/<file>.json] [--keep]
#
# 시나리오:
#   s1 디바이더 리사이즈 스톰(sok, 5s)    s2 뷰 이동 왕복(sok, 5s)
#   s3 사이드바 폭 드래그(입력합성, 5s)    s4 창 리사이즈 드래그(입력합성, 5s)
#   s5 에디터 스크롤(입력합성, 5s)         s6 파일트리 스크롤(입력합성, 5s)
#   s7 유휴(10s)
# s3~s6 은 손쉬운 사용 권한 필요. 권한 없으면 자동 스킵(리포트에 skipped).
set -euo pipefail

PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$PERF_DIR/lib.sh"

IDENTITY="debug"
SCENARIOS="s1,s2,s3,s4,s5,s6,s7"
LABEL="run"
BASELINE=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

export SOKSAK_SOCKET
SOKSAK_SOCKET="$(identity_socket "$IDENTITY")"
[ -S "$SOKSAK_SOCKET" ] || { echo "소켓 없음(앱 실행 중?): $SOKSAK_SOCKET" >&2; exit 1; }

DRIVER="$PERF_DIR/driver.mjs"
SYNTH="$PERF_DIR/.build/synth-input"
RESULTS_DIR="$PERF_DIR/results"
mkdir -p "$RESULTS_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_JSON="$RESULTS_DIR/$TS-$LABEL-$IDENTITY.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 입력 합성기 빌드(멱등 — 소스가 더 새로울 때만).
if [ ! -x "$SYNTH" ] || [ "$PERF_DIR/synth-input.swift" -nt "$SYNTH" ]; then
  mkdir -p "$PERF_DIR/.build"
  swiftc -O "$PERF_DIR/synth-input.swift" -o "$SYNTH" 2>/dev/null \
    || echo "synth-input 빌드 실패 — s3~s6 스킵" >&2
fi

# 손쉬운 사용 권한 확인(없으면 입력합성 시나리오 스킵).
SYNTH_OK=0
if [ -x "$SYNTH" ]; then
  if WB="$("$SYNTH" winbounds "$(identity_app_name "$IDENTITY")" 2>/dev/null)"; then
    SYNTH_OK=1
  fi
fi

# 측정 전 앱 전면 활성화 — 백그라운드 WKWebView 는 이벤트 루프가 스로틀되어
# 측정이 무효가 된다(검증: 비활성 시 RPC RTT 300ms+, 활성 시 2.4ms).
case "$IDENTITY" in
  debug)   open "$REPO_ROOT/src-tauri/target/debug/bundle/macos/soksak-debug.app" ;;
  release) open "$REPO_ROOT/src-tauri/target/release/bundle/macos/soksak.app" ;;
  dev)     osascript -e 'tell application "System Events" to set frontmost of process "soksak-dev" to true' 2>/dev/null || true ;;
esac
sleep 1

# 창 표준화(측정 결정성): 메인 디스플레이 (60,60) 1500×950.
if [ "$SYNTH_OK" = 1 ]; then
  "$SYNTH" setwin "$(identity_app_name "$IDENTITY")" 60 60 1500 950 || true
  sleep 0.8
fi

# ── 레이아웃 셋업(멱등) ──
echo "── setup(perf-harness 프로젝트) ──" >&2
IDS="$(node "$DRIVER" setup "$REPO_ROOT")"
echo "ids: $IDS" >&2
export PERF_IDS="$IDS"

# 합성 좌표 계산(권한 있을 때만): 윈도우 프레임 기준.
if [ "$SYNTH_OK" = 1 ]; then
  WB="$("$SYNTH" winbounds "$(identity_app_name "$IDENTITY")")"
  WX="$(echo "$WB" | jq -r .x)"; WY="$(echo "$WB" | jq -r .y)"
  WW="$(echo "$WB" | jq -r .w)"; WH="$(echo "$WB" | jq -r .h)"
  echo "window: $WB" >&2
fi

# 시나리오 본구간 + 테일(종료 후 8s) 분리 측정 — 사용자 관찰: 상호작용이 끝나고
# 몇 초 뒤 CPU 가 더 크게 오른다(SIGWINCH 폭주 → TUI 연쇄 재그리기 후폭풍 가설).
TAIL_SEC=8

run_scenario() {
  local sc="$1" dur="$2"
  local pids samples="$TMP/$sc.samples"
  pids="$(find_target_pids "$IDENTITY")"
  [ -n "$pids" ] || { echo "{\"error\":\"no pids\"}"; return; }
  sample_cpu "$pids" 0.5 "$samples" &
  local sampler=$!
  case "$sc" in
    s1) node "$DRIVER" s1 "$dur" 90 >&2 ;;
    s2) node "$DRIVER" s2 "$dur" 20 >&2 ;;
    s3)
      # 사이드바 우측 경계(레일 54 + 사이드바 폭 기본 320 ≈ x+374) 왕복 드래그.
      # 갔다가 제자리로 돌아와 폭을 기본값에 유지(멱등 — 다음 실행도 같은 좌표).
      "$SYNTH" drag $(awk "BEGIN{print $WX+374}") $(awk "BEGIN{print $WY+$WH/2}") \
        $(awk "BEGIN{print $WX+474}") $(awk "BEGIN{print $WY+$WH/2}") \
        $(awk "BEGIN{print $dur*500}") 90 >&2
      "$SYNTH" drag $(awk "BEGIN{print $WX+474}") $(awk "BEGIN{print $WY+$WH/2}") \
        $(awk "BEGIN{print $WX+374}") $(awk "BEGIN{print $WY+$WH/2}") \
        $(awk "BEGIN{print $dur*500}") 90 >&2
      ;;
    s4)
      # 우하단 코너 왕복 리사이즈(끝나면 원래 크기로 — 멱등).
      local cx cy
      cx=$(awk "BEGIN{print $WX+$WW-3}"); cy=$(awk "BEGIN{print $WY+$WH-3}")
      "$SYNTH" drag "$cx" "$cy" $(awk "BEGIN{print $cx-250}") $(awk "BEGIN{print $cy-180}") \
        $(awk "BEGIN{print $dur*500}") 90 >&2
      "$SYNTH" drag $(awk "BEGIN{print $cx-250}") $(awk "BEGIN{print $cy-180}") "$cx" "$cy" \
        $(awk "BEGIN{print $dur*500}") 90 >&2
      ;;
    s5)
      # 에디터(우상단 사분면 중앙) 스크롤.
      "$SYNTH" scroll $(awk "BEGIN{print $WX+$WW*0.72}") $(awk "BEGIN{print $WY+$WH*0.3}") \
        -40 $(awk "BEGIN{print int($dur*1000/16)}") 16 >&2
      ;;
    s6)
      # 파일트리(사이드바 중앙) 스크롤.
      "$SYNTH" scroll $(awk "BEGIN{print $WX+214}") $(awk "BEGIN{print $WY+$WH*0.5}") \
        -40 $(awk "BEGIN{print int($dur*1000/16)}") 16 >&2
      ;;
    s7) sleep "$dur" ;;
  esac
  # 본구간 경계 기록 후 테일 계속 샘플링(지연 스파이크 포착).
  local boundary
  boundary="$(wc -l < "$samples" | tr -d ' ')"
  sleep "$TAIL_SEC"
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  local active tail
  active="$(head -n "$boundary" "$samples" | aggregate_stdin)"
  tail="$(tail -n +"$((boundary + 1))" "$samples" | aggregate_stdin)"
  echo "{\"active\":$active,\"tail\":$tail}"
}

declare -a PARTS=()
IFS=',' read -ra SCS <<< "$SCENARIOS"
for sc in "${SCS[@]}"; do
  dur=5; [ "$sc" = "s7" ] && dur=10
  if [[ "$sc" =~ ^s[3-6]$ ]] && [ "$SYNTH_OK" != 1 ]; then
    echo "── $sc: 손쉬운 사용 권한 없음 → 스킵 ──" >&2
    PARTS+=("\"$sc\":{\"skipped\":true}")
    continue
  fi
  echo "── $sc (${dur}s) ──" >&2
  r="$(run_scenario "$sc" "$dur")"
  echo "   $r" >&2
  PARTS+=("\"$sc\":$r")
  sleep 1.5  # 시나리오 간 정착
done

# ── 리포트 ──
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
{
  echo -n "{\"meta\":{\"identity\":\"$IDENTITY\",\"label\":\"$LABEL\",\"git\":\"$GIT_SHA\",\"date\":\"$TS\"},\"scenarios\":{"
  (IFS=,; echo -n "${PARTS[*]}")
  echo "}}"
} | jq . > "$OUT_JSON"

echo ""
echo "## 결과: $LABEL ($IDENTITY, $GIT_SHA) → $OUT_JSON"
echo ""
echo "| 시나리오 | 본구간 평균 | 본구간 최대 | 테일 평균 | 테일 최대 |"
echo "|---|---|---|---|---|"
jq -r '.scenarios | to_entries[]
  | "| \(.key) | \(.value.active.avg // "스킵") | \(.value.active.max // "-") | \(.value.tail.avg // "-") | \(.value.tail.max // "-") |"' "$OUT_JSON"

if [ -n "$BASELINE" ] && [ -f "$BASELINE" ]; then
  echo ""
  echo "## 베이스라인 대비 (${BASELINE##*/})"
  echo ""
  echo "| 시나리오 | 기준 평균 | 현재 평균 | 변화 |"
  echo "|---|---|---|---|"
  jq -rn --slurpfile a "$BASELINE" --slurpfile b "$OUT_JSON" '
    $b[0].scenarios | keys[] as $k
    | ($a[0].scenarios[$k].active.avg // null) as $base
    | ($b[0].scenarios[$k].active.avg // null) as $cur
    | if $base and $cur and $base > 0
      then "| \($k) | \($base) | \($cur) | \((($cur - $base) / $base * 100) | floor)% |"
      else "| \($k) | \($base // "-") | \($cur // "-") | - |" end'
fi

# ── 정리 ──
if [ "$KEEP" != 1 ]; then
  node "$DRIVER" teardown >&2 || true
fi
