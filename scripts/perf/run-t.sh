#!/bin/bash
# 터미널 성능 하니스(W4) — t 시나리오 구동 + CPU/RSS 샘플링 → 리포트 JSON → 예산 게이트.
#
# 사용:
#   scripts/perf/run-t.sh --identity debug [--label baseline] [--t1mb 100]
#     [--scenarios t1_plain,t1_ansi,t2,t5,t6] [--no-gate] [--keep]
#
# 시나리오(전부 소켓 하니스 — 손쉬운 사용 권한 불요, 입력 합성 없음):
#   t1_plain/t1_ansi  처리량: 고정 픽스처 cat → terminal.command.finished 이벤트로 완료(폴링 0)
#   t2                입력 레이턴시 L1: plugin perf.echo 왕복 50회(측정점: onData 도착, 페인트 제외)
#   t5                유휴 CPU(10s)
#   t6                메모리: 대상 PID 군(앱+귀속 WebKit XPC) RSS 합
#
# 기본 순서는 콜드→부하(t5,t6,t2 → t1) — 유휴/메모리/레이턴시를 스크롤백·부하 잔향 없이 잰다.
# 주의: t5/t6 은 앱 "전체"(열린 창 전부) 측정이다 — 창 개수(meta.windowsOpen)가 다르면 수치가
# 다르다. 예산 비교는 같은 창 개수 조건에서만 유효.
#
# 게이트: budgets.json 이 있으면 check-budgets.mjs 로 대조, 위반 시 exit 1 (--no-gate 로 리포트만).
# 전제: 대상 앱 실행 중 + 창이 화면에 보여야 함(백그라운드 WKWebView 스로틀 — run.sh 와 동일).
set -euo pipefail

PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$PERF_DIR/lib.sh"

IDENTITY="debug"
LABEL="t"
T1MB=100
SCENARIOS="t5,t6,t2,t1_plain,t1_ansi"
GATE=1
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --t1mb) T1MB="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --no-gate) GATE=0; shift ;;
    --keep) KEEP=1; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

export SOKSAK_SOCKET
SOKSAK_SOCKET="$(identity_socket "$IDENTITY")"
[ -S "$SOKSAK_SOCKET" ] || { echo "소켓 없음(앱 실행 중?): $SOKSAK_SOCKET" >&2; exit 1; }

DRIVER="$PERF_DIR/driver.mjs"
RESULTS_DIR="$PERF_DIR/results"
mkdir -p "$RESULTS_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_JSON="$RESULTS_DIR/$TS-$LABEL-$IDENTITY.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 측정 전 앱 전면 활성화(백그라운드 WKWebView 이벤트 루프 스로틀 → 측정 무효 — run.sh 검증분).
# 번들이 이 체크아웃 target 에 없으면(워크트리 target 공유) 실행 중 프로세스를 전면화만 한다.
activate_identity() {
  local bundle=""
  case "$IDENTITY" in
    debug)   bundle="$REPO_ROOT/src-tauri/target/debug/bundle/macos/soksak-debug.app" ;;
    release) bundle="$REPO_ROOT/src-tauri/target/release/bundle/macos/soksak.app" ;;
  esac
  if [ -n "$bundle" ] && [ -d "$bundle" ]; then
    open "$bundle"
  else
    osascript -e "tell application \"System Events\" to set frontmost of process \"$(identity_app_name "$IDENTITY")\" to true" 2>/dev/null || true
  fi
}
activate_identity
sleep 1

echo "── setup-t(터미널 1개 perf-harness-t) ──" >&2
IDS="$(node "$DRIVER" setup-t)"
echo "ids: $IDS" >&2
export PERF_IDS="$IDS"

PIDS="$(find_target_pids "$IDENTITY")"
[ -n "$PIDS" ] || { echo "대상 PID 없음" >&2; exit 1; }
echo "pids: $PIDS" >&2

# CPU 샘플링을 곁들여 드라이버 시나리오 1개 실행 → {…driver JSON…, "cpu":{avg,max}} 병합.
run_with_cpu() {
  local samples="$TMP/cpu.$$.$RANDOM"
  sample_cpu "$PIDS" 0.5 "$samples" &
  local sampler=$!
  local out
  out="$("$@")"
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  local cpu
  cpu="$(aggregate_stdin < "$samples")"
  jq -c --argjson cpu "$cpu" '. + {cpu: $cpu}' <<< "$out"
}

declare -a PARTS=()
IFS=',' read -ra SCS <<< "$SCENARIOS"
for sc in "${SCS[@]}"; do
  echo "── $sc ──" >&2
  case "$sc" in
    t1_plain) r="$(run_with_cpu node "$DRIVER" t1 plain "$T1MB")" ;;
    t1_ansi)  r="$(run_with_cpu node "$DRIVER" t1 ansi "$T1MB")" ;;
    t2)       r="$(node "$DRIVER" t2 50)" ;;
    t5)
      samples="$TMP/idle.samples"
      sample_cpu "$PIDS" 0.5 "$samples" &
      sampler=$!
      sleep 10
      kill "$sampler" 2>/dev/null || true
      wait "$sampler" 2>/dev/null || true
      r="{\"scenario\":\"t5_idle\",\"seconds\":10,\"cpu\":$(aggregate_stdin < "$samples")}"
      ;;
    t6)
      rss_kb="$(ps -o rss= -p "$(echo "$PIDS" | tr ' ' ',')" | awk '{s+=$1} END {print s}')"
      npids="$(echo "$PIDS" | wc -w | tr -d ' ')"
      r="{\"scenario\":\"t6_memory\",\"rssMb\":$(awk "BEGIN{printf \"%.1f\", $rss_kb/1024}"),\"pids\":$npids}"
      ;;
    *) echo "알 수 없는 시나리오: $sc" >&2; exit 2 ;;
  esac
  echo "   $r" >&2
  key="$(jq -r .scenario <<< "$r")"
  PARTS+=("\"$key\":$(jq -c 'del(.scenario)' <<< "$r")")
  sleep 1.5 # 시나리오 간 정착
done

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
MACHINE="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
WINDOWS_OPEN="$(jq -r '.windowsOpen // 0' <<< "$IDS")"
{
  echo -n "{\"meta\":{\"identity\":\"$IDENTITY\",\"label\":\"$LABEL\",\"git\":\"$GIT_SHA\",\"date\":\"$TS\",\"t1mb\":$T1MB,\"windowsOpen\":$WINDOWS_OPEN,\"machine\":$(jq -Rn --arg m "$MACHINE" '$m')},\"scenarios\":{"
  (IFS=,; echo -n "${PARTS[*]}")
  echo "}}"
} | jq . > "$OUT_JSON"

echo ""
echo "## 결과: $LABEL ($IDENTITY, $GIT_SHA, t1=${T1MB}MB) → $OUT_JSON"
jq -r '.scenarios | to_entries[] | "  \(.key): \(.value | tojson)"' "$OUT_JSON"

if [ "$KEEP" != 1 ]; then
  node "$DRIVER" teardown-t >&2 || true
fi

if [ "$GATE" = 1 ]; then
  if [ -f "$PERF_DIR/budgets.json" ]; then
    node "$PERF_DIR/check-budgets.mjs" "$OUT_JSON"
  else
    echo "budgets.json 없음 — 게이트 생략(첫 실측으로 초기값을 확정해 커밋할 것)" >&2
  fi
fi
