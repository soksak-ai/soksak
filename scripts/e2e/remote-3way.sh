#!/bin/bash
# 원격(remote-iroh 사이드카) 3종 E2E — 폰 완결 기준(A6, 확정 결정 2):
#   ① 활동 스트림(커서): activity.recent{since} 가 원격 왕복으로 새 항목만 돌려준다(P11 —
#      push 불가 원격 클라이언트의 정본 경로. 요청 시점 catch-up 조회는 폴링이 아니다).
#   ② 커맨드 왕복(관찰): state.tree 가 Noise KK + Ed25519 assertion + chunking 을 지나 온전히 돈다.
#   ③ danger 게이트: --destructive 가 데스크톱 confirm 모달을 발동, 승인=실행·거부=미실행(fail-closed).
#
# 전제: debug 앱 실행 중(소켓 ~/.soksak/com.soksak.debug.sock) + remote-iroh 플러그인 dev 체크아웃의
# src-rust 가 빌드돼 있음(cargo build --bins). 사이드카는 이 스크립트가 임시 페어링으로 띄우고 내린다
# (임시 신원·키는 매 실행 재생성 — 멱등, 프로덕션 페어링 무영향).
#
# 사용: bash scripts/e2e/remote-3way.sh [--identity debug]
set -uo pipefail

IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
SOCK="$HOME/.soksak/com.soksak.${IDENTITY}.sock"
RI="$HOME/.soksak/plugins/soksak-plugin-remote-iroh/src-rust/target/debug"
WORK=$(mktemp -d)
PORT=48620
trap 'kill "$SIDECAR_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

[ -S "$SOCK" ] || { echo "FAIL: 앱 소켓 없음($SOCK) — debug 앱을 먼저 실행"; exit 1; }
[ -x "$RI/sok-remote" ] || { echo "FAIL: sok-remote 미빌드 — (cd plugin/src-rust && cargo build --bins)"; exit 1; }

# 소켓 헬퍼(window 명시 — orch 창이 활성일 때의 라우팅 함정 회피).
core() { python3 -c "
import socket,json,sys
s=socket.socket(socket.AF_UNIX); s.connect('$SOCK')
req={'id':1,'method':sys.argv[1],'params':json.loads(sys.argv[2] if len(sys.argv)>2 else '{}'),'window':'main'}
s.sendall((json.dumps(req)+'\n').encode())
buf=b''
while b'\n' not in buf: buf+=s.recv(65536)
print(buf.split(b'\n')[0].decode())
" "$@"; }

# ── 셋업: 임시 폰 신원 + 페어링 + 사이드카(TCP 루프백 — serve_connection/보안 floor 는 iroh 와 동일) ──
BUNDLE=$("$RI/sok-remote" pair 2>/dev/null | python3 -c "import sys,re,json; print(re.search(r'\{.*?\}',sys.stdin.read(),re.S).group(0))")
PAIRED=$(python3 -c "
import json,sys
b=json.loads('''$BUNDLE''')
print(json.dumps([{'device_id':b['device_id'],'x25519_pub':b['x25519_public'],'ed25519_pub':b['ed25519_public'],'granted_scope':'destructive'}]))
")
SOKSAK_SOCKET="$SOCK" SOKSAK_REMOTE_TCP=1 SOKSAK_REMOTE_TCP_PORT=$PORT \
SOKSAK_REMOTE_DESKTOP_KEY_PATH="$WORK/desktop.key" \
SOKSAK_REMOTE_PAIRED_DEVICES_JSON="$PAIRED" SOKSAK_WINDOW=main \
"$RI/soksak-remote-iroh" > "$WORK/sidecar.log" 2>&1 &
SIDECAR_PID=$!
sleep 3
DESK=$(grep -o "= [0-9a-f]\{64\}" "$WORK/sidecar.log" | head -1 | awk '{print $2}')
DEVID=$(python3 -c "import json; print(json.loads('''$BUNDLE''')['device_id'])")
[ -n "$DESK" ] || { echo "FAIL: 사이드카 기동 실패"; cat "$WORK/sidecar.log"; exit 1; }
CALL() { "$RI/sok-remote" call "127.0.0.1:$PORT" "$DEVID" "$DESK" "$@"; }

PASS=0; FAIL=0
ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
ng() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# ── ② 커맨드 왕복(관찰) ──
CALL state.tree '{}' 2>/dev/null | python3 -c "
import json,sys; v=json.load(sys.stdin); assert v.get('ok') and 'projects' in v" \
  && ok "② 왕복: state.tree (Noise KK + Ed25519 + chunking)" || ng "② 왕복"

# ── ① 활동 스트림(커서) ──
S1=$(CALL activity.recent '{"limit":5}' 2>/dev/null | python3 -c "import json,sys; v=json.load(sys.stdin); print(v['entries'][-1]['seq'] if v.get('entries') else 0)")
core view.list >/dev/null   # 활동 생성(registry 계측이 command.executed 를 발행)
sleep 1
CALL activity.recent "{\"since\":$S1}" 2>/dev/null | python3 -c "
import json,sys
v=json.load(sys.stdin); es=v.get('entries',[])
assert es and all(e['seq']>$S1 for e in es) and any(e['kind']=='command.executed' for e in es)" \
  && ok "① 스트림(커서): since=$S1 이후 신규 항목만 수신" || ng "① 스트림(커서)"

# 대상 터미널 pane(main 창 첫 터미널)
PANE=$(core state.tree | python3 -c "
import json,sys
v=json.load(sys.stdin)
panes=[vv['id'] for p in v.get('projects',[]) for c in p['contents'] for g in c['panels'] for vv in g['views'] if vv.get('plugin')=='soksak-plugin-terminal']
print(panes[0] if panes else '')")
[ -n "$PANE" ] || { ng "터미널 pane 없음"; echo "PASS=$PASS FAIL=$((FAIL+2))"; exit 1; }

# ── ③ danger 게이트: 승인=실행 ──
NONCE=$RANDOM
( sleep 3; for i in $(seq 1 15); do
    A=$(core ui.tree | python3 -c "
import json,sys
v=json.load(sys.stdin)
n=[x['address'] for x in v.get('nodes',[]) if x.get('address','').endswith('remote-confirm/approve')]
print(n[0] if n else '')")
    [ -n "$A" ] && { core ui.input.click "{\"address\":\"$A\"}" >/dev/null; break; }
    sleep 1
  done ) &
APPROVER=$!
CALL term.exec "{\"cmd\":\"echo a6-run-$NONCE\",\"pane\":\"$PANE\"}" --destructive 2>/dev/null \
  | python3 -c "import json,sys; v=json.load(sys.stdin); assert v.get('ok')" \
  && true || ng "③ 승인 경로 원격 응답"
# wait 무인자 금지 — 백그라운드 사이드카까지 기다려 영원 대기(실측).
wait $APPROVER; sleep 1
core term.read "{\"pane\":\"$PANE\",\"lines\":60}" | grep -q "a6-run-$NONCE" \
  && ok "③ danger 승인: 모달 승인 → 실제 실행 확인" || ng "③ danger 승인 실행"

# ── ③ danger 게이트: 거부=미실행(fail-closed) ──
( sleep 3; for i in $(seq 1 15); do
    D=$(core ui.tree | python3 -c "
import json,sys
v=json.load(sys.stdin)
n=[x['address'] for x in v.get('nodes',[]) if x.get('address','').endswith('remote-confirm/deny')]
print(n[0] if n else '')")
    [ -n "$D" ] && { core ui.input.click "{\"address\":\"$D\"}" >/dev/null; break; }
    sleep 1
  done ) &
DENIER=$!
OUT=$(CALL term.exec "{\"cmd\":\"echo a6-deny-$NONCE\",\"pane\":\"$PANE\"}" --destructive 2>/dev/null)
wait $DENIER; sleep 1
echo "$OUT" | grep -q '"ok":false' && ! core term.read "{\"pane\":\"$PANE\",\"lines\":40}" | grep -q "a6-deny-$NONCE" \
  && ok "③ danger 거부: fail-closed(미실행)" || ng "③ danger 거부"

echo ""
echo "remote-3way: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
