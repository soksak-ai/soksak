#!/bin/bash
# 퍼포먼스 하니스 공용 함수 — 대상 프로세스 탐색 + CPU 샘플링.
# identity: debug | dev | release
set -euo pipefail

PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PERF_DIR/../.." && pwd)"

identity_socket() {
  case "$1" in
    # identity 홈 계약(docs/ARCHITECTURE.md): app=~/.soksak, 그 외 ~/.soksak-<identity>.
    debug)   echo "$HOME/.soksak-debug/com.soksak.debug.sock" ;;
    dev)     echo "$HOME/.soksak-dev/com.soksak.dev.sock" ;;
    release) echo "$HOME/.soksak/com.soksak.app.sock" ;;
    *) echo "unknown identity: $1" >&2; return 1 ;;
  esac
}

identity_proc_pattern() {
  # 앱 메인 프로세스 매칭 패턴(ps command 기준).
  case "$1" in
    debug)   echo "soksak-debug.app/Contents/MacOS/soksak-debug" ;;
    dev)     echo "target/debug/soksak-dev" ;;
    release) echo "soksak.app/Contents/MacOS/soksak" ;;
  esac
}

identity_app_name() {
  # NSWorkspace/AX 에서 앱을 찾을 때 쓰는 실행 파일 이름.
  case "$1" in
    debug)   echo "soksak-debug" ;;
    dev)     echo "soksak-dev" ;;
    release) echo "soksak" ;;
  esac
}

identity_lsof_pattern() {
  # WebKit XPC 프로세스를 앱에 귀속시키는 lsof 문자열.
  case "$1" in
    debug)   echo "com.soksak.debug" ;;
    dev)     echo "soksak-dev" ;;
    release) echo "com.soksak/" ;;  # com.soksak.debug/dev 와 구분 위해 / 포함
  esac
}

# etime([[dd-]hh:]mm:ss) → 초.
etime_to_sec() {
  awk -F'[-:]' '{
    n = NF
    s = $(n) + $(n-1) * 60
    if (n >= 3) s += $(n-2) * 3600
    if (n >= 4) s += $(n-3) * 86400
    print int(s)
  }' <<< "$1"
}

# 대상 PID 집합: 앱 메인 + 귀속 WebKit XPC(WebContent/GPU/Networking).
# 귀속 규칙(이중):
#   1) 앱과 같은 시각(±5s)에 시작된 WebKit XPC — 메인 webview/GPU/Networking 은
#      앱과 동시에 뜨지만, 번들 자산만 쓰는 메인 WebContent 는 lsof 마커가 없다.
#   2) lsof 에 identity 마커가 보이는 WebKit XPC — 늦게 뜨는 브라우저 자식
#      webview 는 네트워크 캐시 파일로 식별된다.
find_target_pids() {
  local identity="$1"
  local app_pat lsof_pat pids=()
  app_pat="$(identity_proc_pattern "$identity")"
  lsof_pat="$(identity_lsof_pattern "$identity")"

  local app_pid
  app_pid="$(pgrep -f "$app_pat" | head -1 || true)"
  [ -z "$app_pid" ] && { echo ""; return; }
  pids+=("$app_pid")

  local app_et
  app_et="$(etime_to_sec "$(ps -o etime= -p "$app_pid" | tr -d ' ')")"

  local wk wk_et diff
  for wk in $(pgrep -f "com.apple.WebKit" || true); do
    wk_et="$(ps -o etime= -p "$wk" 2>/dev/null | tr -d ' ')"
    [ -z "$wk_et" ] && continue
    wk_et="$(etime_to_sec "$wk_et")"
    diff=$((app_et - wk_et)); [ "$diff" -lt 0 ] && diff=$((-diff))
    if [ "$diff" -le 5 ] || lsof -p "$wk" 2>/dev/null | grep -q "$lsof_pat"; then
      pids+=("$wk")
    fi
  done
  echo "${pids[@]}"
}

# CPU 샘플러: pid 목록의 %cpu 합을 interval 초마다 기록. 종료는 SIGTERM.
# 사용: sample_cpu "pid1 pid2" interval outfile  (백그라운드 실행 전제)
sample_cpu() {
  local pids="$1" interval="$2" out="$3"
  : > "$out"
  local plist
  plist="$(echo "$pids" | tr ' ' ',')"
  while true; do
    ps -o %cpu= -p "$plist" 2>/dev/null | awk '{s+=$1} END {printf "%.1f\n", s}' >> "$out"
    sleep "$interval"
  done
}

# 샘플 스트림(stdin) → avg/max JSON 조각.
aggregate_stdin() {
  awk '
    { s += $1; if ($1 > mx) mx = $1; n++ }
    END {
      if (n == 0) { print "{\"avg\":0,\"max\":0,\"samples\":0}" }
      else { printf "{\"avg\":%.1f,\"max\":%.1f,\"samples\":%d}", s/n, mx, n }
    }'
}
