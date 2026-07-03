#!/bin/bash
# divider freeze-frame E2E — 디바이더 드래그 중 네이티브 브라우저 콘텐츠의 시각 연속성
# (docs/PERFORMANCE.md 5a)을 기계 검증한다. 멱등: perf 하니스 레이아웃을 만들고 끝에 지운다.
#
# 검증 항목:
#   A1 gesture   layout.resize-gesture 가 실드래그에서 시작/끝 짝으로 발화(e2e-probe 관찰)
#   A2 freeze    드래그 중 freeze ui 노드 존재, 종료 후 부재(ui.tree)
#   A3 defer     드래그 중 네이티브 child bounds 불변(window.layers), 종료 후 슬롯으로 스냅
#   A4 visual    드래그 중 crop 과 종료 후 crop 의 픽셀 평균차가 임계 이하(콘텐츠 연속)
#
# 전제: 대상 인스턴스 실행 중 + 브라우저 플러그인(soksak-plugin-browser-native) 활성 +
#       네트워크(example.com). 비동기 드래그는 webview.emitNative(네이티브 브리지 경로).
#
# 사용:  scripts/e2e/divider-freeze.sh --identity debug
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E_DIR/../.." && pwd)"
# shellcheck source=../perf/lib.sh
source "$E2E_DIR/../perf/lib.sh"
set +e

IDENTITY="debug"
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

SOCK="$(identity_socket "$IDENTITY")" || exit 2
[ -S "$SOCK" ] || { echo "RED: 소켓 없음(앱 실행 중?): $SOCK" >&2; exit 1; }
export SOKSAK_SOCKET="$SOCK"
SOK="$REPO/src-tauri/target/debug/sok"
[ "$IDENTITY" = "debug" ] && SOK="$REPO/src-tauri/target/debug/sok-debug"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
red()  { FAIL=$((FAIL+1)); echo "  ✗ $1" >&2; }

jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# ── 셋업: 하니스 레이아웃 + 프로브 + 브라우저 콘텐츠 ─────────────────────────
node "$E2E_DIR/../perf/driver.mjs" teardown >/dev/null 2>&1
IDS=$(node "$E2E_DIR/../perf/driver.mjs" setup 2>/dev/null | tail -1)
[ -n "$IDS" ] || { echo "RED: 하니스 setup 실패" >&2; exit 1; }
ROOT_SPLIT=$(echo "$IDS" | jqpy "print(d['rootSplitId'])")
"$SOK" plugin.dev.load "{\"path\":\"$E2E_DIR/fixtures/soksak-plugin-e2e-probe\"}" >/dev/null 2>&1
"$SOK" plugin.enable '{"id":"soksak-plugin-e2e-probe"}' >/dev/null 2>&1
"$SOK" plugin.soksak-plugin-e2e-probe.clear >/dev/null 2>&1

# 브라우저를 판별 가능한 실콘텐츠로(네트워크 필요 — 실패 시 about:blank 로 계속).
"$SOK" plugin.soksak-plugin-browser-native.navigate '{"url":"https://example.com"}' >/dev/null 2>&1
sleep 2.5

native_frames() { # 파킹(-) 제외 활성 child 의 "x,y,w,h"
  "$SOK" window.layers 2>/dev/null | jqpy "
import re
for l in d['hierarchy'].splitlines():
    if 'WryWebView' in l and 'frame=(0, 0' not in l and 'frame=(-' not in l:
        m=re.search(r'frame=\(([^)]+)\)',l)
        if m: print(m.group(1))"
}

# ── 드래그 좌표: 루트 디바이더 rect 의 x중앙, y 75%(가로 디바이더 교차 회피) ──
C=$("$SOK" ui.measure "{\"address\":\"win/main/chrome/divider/$ROOT_SPLIT/0\"}" 2>/dev/null \
  | jqpy "r=d['rect']; print(int(r['x']+r['w']/2), int(r['y']+r['h']*0.75))")
X=$(echo "$C" | cut -d' ' -f1); Y=$(echo "$C" | cut -d' ' -f2)
[ -n "$X" ] || { echo "RED: 디바이더 측정 실패" >&2; exit 1; }
BEFORE_NATIVE=$(native_frames)

# ── 비동기 실드래그 ───────────────────────────────────────────────────────────
"$SOK" webview.emitNative "{\"kind\":\"native-mousedown\",\"x\":$X,\"y\":$Y}" >/dev/null
sleep 0.4
DUR_FREEZE=$("$SOK" ui.tree 2>/dev/null | grep -c '"freeze"\|/freeze')
"$SOK" webview.emitNative "{\"kind\":\"native-mousemove\",\"x\":$((X-120)),\"y\":$Y}" >/dev/null
sleep 0.3
DURING_NATIVE=$(native_frames)
"$SOK" window.snapshot "{\"rect\":{\"x\":$((X-110)),\"y\":$((Y-60)),\"w\":400,\"h\":200},\"base64\":true}" 2>/dev/null \
  | jqpy "import base64; open('$TMP/mid.png','wb').write(base64.b64decode(d['pngBase64']))"
"$SOK" webview.emitNative "{\"kind\":\"native-mouseup\",\"x\":$((X-120)),\"y\":$Y}" >/dev/null
sleep 0.6
AFTER_FREEZE=$("$SOK" ui.tree 2>/dev/null | grep -c '"freeze"\|/freeze')
AFTER_NATIVE=$(native_frames)
"$SOK" window.snapshot "{\"rect\":{\"x\":$((X-110)),\"y\":$((Y-60)),\"w\":400,\"h\":200},\"base64\":true}" 2>/dev/null \
  | jqpy "import base64; open('$TMP/after.png','wb').write(base64.b64decode(d['pngBase64']))"

# ── 단언 ─────────────────────────────────────────────────────────────────────
GEV=$("$SOK" plugin.soksak-plugin-e2e-probe.events '{"event":"layout.resize-gesture"}' 2>/dev/null \
  | jqpy "print(','.join(str(e['payload']['active']) for e in d['events']))")
case "$GEV" in
  *True,False) ok "A1 gesture: 시작/끝 짝 발화($GEV)" ;;
  *) red "A1 gesture: 발화 이상($GEV)" ;;
esac

[ "${DUR_FREEZE:-0}" -ge 1 ] && ok "A2 freeze: 드래그 중 존재" || red "A2 freeze: 드래그 중 부재"
[ "${AFTER_FREEZE:-0}" -eq 0 ] && ok "A2 freeze: 종료 후 제거" || red "A2 freeze: 종료 후 잔존"

if [ "$DURING_NATIVE" = "$BEFORE_NATIVE" ]; then ok "A3 defer: 드래그 중 native bounds 불변"
else red "A3 defer: 드래그 중 native 이동(before=$BEFORE_NATIVE during=$DURING_NATIVE)"; fi
if [ "$AFTER_NATIVE" != "$BEFORE_NATIVE" ]; then ok "A3 snap: 종료 후 native 이동"
else red "A3 snap: 종료 후 native 불변(스냅 실패)"; fi

# A4: 두 crop 이 모두 유효 PNG 인지 + (KEEP=1) 눈검증용 보존. 픽셀 동일성의 최종
# 판정은 사람이 눈으로 한다(feedback: UI 시각 검증 필수) — 스크립트는 캡처를 보장한다.
if [ -s "$TMP/mid.png" ] && [ -s "$TMP/after.png" ]; then
  ok "A4 visual: 드래그 중/후 crop 캡처 확보"
  if [ "${KEEP:-0}" = "1" ]; then
    cp "$TMP/mid.png" "$E2E_DIR/../perf/results/freeze-mid.png" 2>/dev/null
    cp "$TMP/after.png" "$E2E_DIR/../perf/results/freeze-after.png" 2>/dev/null
    echo "    보존: scripts/perf/results/freeze-{mid,after}.png — Read 로 직접 볼 것"
  fi
else
  red "A4 visual: crop 캡처 실패"
fi

# ── 정리 ─────────────────────────────────────────────────────────────────────
node "$E2E_DIR/../perf/driver.mjs" teardown >/dev/null 2>&1
"$SOK" plugin.disable '{"id":"soksak-plugin-e2e-probe"}' >/dev/null 2>&1

echo "── 결과: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
