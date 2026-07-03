#!/bin/bash
# 실드래그 CPU 측정 — 네이티브 브리지(webview.emitNative)로 divider 연속 드래그(~4.7s,
# ~30Hz move)를 구동하며 앱 메인+CEF 프로세스 CPU 를 샘플한다. freeze-frame(성능 헌법 5a)
# 게이트의 측정 도구(scripts/perf/results/20260704-d-drag-freeze-gate.md 참조). 멱등:
# 레이아웃은 건드리지 않고 마지막 divider 를 좌우로 흔들며 원위치로 끝낸다.
#
# 사용: scripts/perf/drag-cpu.sh --identity debug [--label NAME]
set -u
PERF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$PERF_DIR/../.." && pwd)"
source "$PERF_DIR/lib.sh"
set +e # lib 가 켠 -e 해제 — pid 폴백 등 개별 실패는 직접 처리(resize.sh 선례)

IDENTITY="debug"; LABEL="drag"
while [ $# -gt 0 ]; do case "$1" in
  --identity) IDENTITY="$2"; shift 2 ;;
  --label) LABEL="$2"; shift 2 ;;
  *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
esac; done

export SOKSAK_SOCKET; SOKSAK_SOCKET="$(identity_socket "$IDENTITY")"
[ -S "$SOKSAK_SOCKET" ] || { echo "소켓 없음: $SOKSAK_SOCKET" >&2; exit 1; }
SOK="$REPO/src-tauri/target/debug/sok"; [ "$IDENTITY" = "debug" ] && SOK="$REPO/src-tauri/target/debug/sok-debug"

# pid 귀속: 번들/bare 모두 커버(메인) + CEF 헬퍼. WebKit XPC 는 lsof 전수라 느려 제외 —
# 드래그 경로의 지배 비용(bounds IPC·setFrame·CEF churn)은 메인+CEF 에 잡힌다.
MAIN_PID=$(pgrep -f "$(identity_proc_pattern "$IDENTITY")" | head -1)
[ -n "$MAIN_PID" ] || MAIN_PID=$(pgrep -f "target/debug/$(identity_app_name "$IDENTITY")\$" | head -1)
CEF_PIDS=$(pgrep -f "soksak-sidecar-browser-chromium" | tr '\n' ' ')
PIDS="$MAIN_PID $CEF_PIDS"
[ -n "$MAIN_PID" ] || { echo "앱 pid 못 찾음($IDENTITY)" >&2; exit 1; }

DIV=$($SOK ui.tree 2>/dev/null | grep -o '"win/main/chrome/divider/[^"]*"' | sort -u | tail -1 | tr -d '"')
[ -n "$DIV" ] || { echo "divider 없음(분할 레이아웃 필요)" >&2; exit 1; }
R=$($SOK ui.measure "{\"address\":\"$DIV\"}" 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin)['rect']; print(int(r['x']+r['w']/2), int(r['y']+r['h']*0.5))")
X=$(echo "$R" | cut -d' ' -f1); Y=$(echo "$R" | cut -d' ' -f2)

OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
sample_cpu "$PIDS" 0.3 "$OUT" & SPID=$!
$SOK webview.emitNative "{\"kind\":\"native-mousedown\",\"x\":$X,\"y\":$Y}" >/dev/null
for i in $(seq 1 75); do
  DX=$(( (i % 30) - 15 ))
  $SOK webview.emitNative "{\"kind\":\"native-mousemove\",\"x\":$((X+DX*6)),\"y\":$Y}" >/dev/null
  sleep 0.03
done
$SOK webview.emitNative "{\"kind\":\"native-mouseup\",\"x\":$X,\"y\":$Y}" >/dev/null
sleep 0.5; kill $SPID 2>/dev/null
python3 -c "
vals=[float(l.strip()) for l in open('$OUT') if l.strip()]
print(f'$LABEL drag CPU: avg={sum(vals)/len(vals):.1f}% max={max(vals):.1f}% n={len(vals)}')"
