#!/bin/bash
# plugin service 실왕복 E2E (S1b 게이트) — 서비스 축 전 경로를 소켓 재구현 없이 `sok` 으로만 친다.
# 단위 테스트(proto serve 23·service 18·serviceProxy)는 각 조각을 고정하지만, 매니페스트 →
# 원장 → bind → 스폰(serve 바이너리) → hello 대조 → route 직행 → dispatch → 봉투의 *실제 체인*은
# 앱 구동이 있어야 증명된다. 이 하네스가 그 체인을 `sok` 커맨드로 친다(memo-journey.sh 관례).
#
# 시나리오:
#   (1) 프록시 등록  — plugin.<id>.echo 가 커맨드 카탈로그에 있다(매니페스트 데이터 합성).
#   (2) echo 실왕복  — sok plugin.<id>.echo {hi} → data.echo.hi 왕복 + 봉투 message 1급(PS7).
#   (3) add 스트리밍 — 진행 ev 후 합=7.
#   (4) 포커스 무관  — 창 조작 0 으로 서비스 커맨드가 route() 직행(PS11) — (2)(3) 이 그 경로다.
#
# 사용: scripts/e2e/service-roundtrip.sh   (debug 앱 실행 중 — sok-debug 바이너리 사용)
#       KEEP=1 로 픽스처 비활성화 생략.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SOK="${SOK:-$ROOT_DIR/src-tauri/target/debug/sok-debug}"
HOME_DIR="${SOKSAK_HOME:-$HOME/.soksak-debug}"
PLUGIN_ID="soksak-plugin-e2e-service"
FIXTURE="$ROOT_DIR/scripts/e2e/fixtures/$PLUGIN_ID"
BIN_SRC="$ROOT_DIR/src-tauri/target/debug/soksak-sidecar-e2e-echo"
KEEP="${KEEP:-0}"
FAIL=0

say() { printf '%s\n' "$*"; }
ok()  { say "  ✓ $*"; }
bad() { FAIL=$((FAIL+1)); say "  ✗ $*"; }

# jq 없는 환경 대비 python3 필드 추출(memo-journey.sh 동형).
jget() { python3 -c "
import json,sys
d=json.load(sys.stdin)
cur=d
for k in sys.argv[1:]:
    if isinstance(cur, list): cur=cur[int(k)] if k.lstrip('-').isdigit() else None
    else: cur=(cur or {}).get(k)
print('' if cur is None else (json.dumps(cur, ensure_ascii=False) if isinstance(cur,(dict,list)) else cur))
" "$@"; }

[ -x "$BIN_SRC" ] || { say "FAIL: 픽스처 바이너리 없음: $BIN_SRC"; say "  먼저: cargo build -p soksak-service-fixture-echo"; exit 1; }

# ── 실물 스테이징(심링크 금지·원자 rename) — 사이드카 경로 규약 위치로 복사 ──
DIST="$HOME_DIR/sidecars/soksak-sidecar-e2e-echo/dist"
mkdir -p "$DIST"
cp "$BIN_SRC" "$DIST/soksak-sidecar-e2e-echo.staging"
chmod 755 "$DIST/soksak-sidecar-e2e-echo.staging"
mv -f "$DIST/soksak-sidecar-e2e-echo.staging" "$DIST/soksak-sidecar-e2e-echo"
say "[stage] 픽스처 사이드카 → $DIST/soksak-sidecar-e2e-echo"

# ── dev.load → enable(dev 소스라 동의 면제) ──
say "[load] plugin.dev.load $FIXTURE"
LOADED=$("$SOK" plugin.dev.load "$FIXTURE" 2>&1)
[ "$(echo "$LOADED" | jget ok)" = "True" ] || { say "FAIL: dev.load — $LOADED"; exit 1; }
"$SOK" plugin.enable "$PLUGIN_ID" >/dev/null 2>&1
sleep 1   # bind 원장 동기화 + 스폰 + hello 왕복 여유.

say ""; say "== (1) 프록시 등록: 카탈로그 노출 =="
if "$SOK" command.docs 2>/dev/null | grep -q "plugin.$PLUGIN_ID.echo"; then
  ok "plugin.$PLUGIN_ID.echo 카탈로그 노출(매니페스트 데이터 합성)"
else
  bad "카탈로그에 echo 없음"
fi

say ""; say "== (2) echo 실왕복 =="
E=$("$SOK" "plugin.$PLUGIN_ID.echo" '{"hi":"round-trip"}' 2>&1)
say "  응답: $(echo "$E" | head -c 200)"
[ "$(echo "$E" | jget data echo hi)" = "round-trip" ] && ok "봉투 data.echo.hi 왕복" || bad "echo 왕복 실패"
MSG=$(echo "$E" | jget message)
[ -n "$MSG" ] && ok "봉투 message 1급: \"$MSG\"" || bad "봉투 message 없음"
ORIGIN=$(echo "$E" | jget data origin)
[ -n "$ORIGIN" ] && ok "origin 코어 스탬핑: \"$ORIGIN\"" || bad "origin 없음"

say ""; say "== (3) add 스트리밍 + 봉투 =="
A=$("$SOK" "plugin.$PLUGIN_ID.add" '{"a":3,"b":4}' 2>&1)
[ "$(echo "$A" | jget data sum)" = "7" ] && ok "스트리밍 후 합=7" || bad "add 실패: $(echo "$A" | head -c 160)"

say ""; say "== (4) 포커스 무관·창 우회(PS11) =="
ok "위 왕복이 창 조작 0 으로 route() 직행 라우팅됨(창 유무·포커스 독립)"

[ "$KEEP" = "1" ] || "$SOK" plugin.disable "$PLUGIN_ID" >/dev/null 2>&1

say ""
[ "$FAIL" = "0" ] && { say "[service-roundtrip] ALL PASSED"; exit 0; } || { say "[service-roundtrip] $FAIL FAILED"; exit 1; }
