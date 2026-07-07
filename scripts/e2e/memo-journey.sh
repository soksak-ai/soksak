#!/bin/bash
# memo-app 여정 재연 E2E — 외부 에이전트가 헤맸던 시나리오를, 각 단계의 응답 정보(hint 포함)만으로
# 헤맴 없이 완주할 수 있는지 검증한다. hint 는 선택지 제시이므로 판정 기준은 "맹종 가능"이 아니라
# "외부 지식·소거법 탐색 없이 판단 가능"이다: 응답의 window·hint·message 가 다음 갈래를 담는가.
#
# 여정: 제어판(main)에서 project.open → 전용 창 라우팅 → 그 창에서 layout.apply(dev)
#       → 데몬 등록(daemon.add)·기동(daemon.start)·로그(daemon.logs) → 스냅샷 확인.
# 사용: scripts/e2e/memo-journey.sh   (debug 앱 실행 중이어야 한다 — sok-debug 이름 바이너리 사용)
set -euo pipefail

SOK="${SOK:-src-tauri/target/debug/sok-debug}"
ROOT="$HOME/.soksak-e2e/memo-journey"   # 고정 픽스처 루트(재사용·멱등)
FAIL=0

say() { printf '%s\n' "$*"; }
die() { say "FAIL: $*"; exit 1; }

# jq 필드 추출(파이썬 의존 제거를 위해 jq 사용 — 없으면 python3 폴백)
jget() { python3 -c "
import json,sys
d=json.load(sys.stdin)
cur=d
for k in sys.argv[1:]:
    if isinstance(cur, list): cur=cur[int(k)]
    else: cur=(cur or {}).get(k)
print('' if cur is None else (json.dumps(cur, ensure_ascii=False) if isinstance(cur,(dict,list)) else cur))
" "$@"; }

step() { say ""; say "== $1 =="; }

mkdir -p "$ROOT"
[ -f "$ROOT/server.mjs" ] || cat > "$ROOT/server.mjs" << 'EOF'
import { createServer } from "node:http";
createServer((_, res) => { res.end("memo-journey ok"); }).listen(18917, () => console.log("listening 18917"));
EOF

step "0. 사전 정리(멱등) — 이전 실행의 창·점유 해제"
PREV=$("$SOK" --window main window.projects 2>/dev/null | jget data projects || echo "[]")
say "이전 점유: $(echo "$PREV" | head -c 120)"
# 이 루트를 점유한 창이 있으면 닫는다(창 파괴 계약이 데몬·점유를 정리)
LABELS=$(echo "$PREV" | python3 -c "
import json,sys
try: pr=json.load(sys.stdin)
except: pr=[]
print(' '.join(p.get('window','') for p in pr if p.get('root','')=='$ROOT'))" 2>/dev/null || echo "")
for L in $LABELS; do [ -n "$L" ] && "$SOK" --window main window.close "{\"label\":\"$L\"}" >/dev/null 2>&1 || true; done
sleep 1

step "1. 제어판에서 project.open — 전용 창으로 라우팅되는가"
R=$("$SOK" --window main project.open "{\"root\":\"$ROOT\"}")
say "$R"
ROUTED=$(echo "$R" | jget data routedWindow)
[ -n "$ROUTED" ] || die "routedWindow 없음 — 제어판 라우팅 실패"
HINT1=$(echo "$R" | jget hint 0 cmd)
say "routedWindow=$ROUTED / hint[0]=$HINT1"
echo "$HINT1" | grep -q -- "--window $ROUTED" || { say "WARN: hint 가 라우팅 창 사용법을 안내하지 않음"; FAIL=1; }
sleep 3

step "2. 응답 안내대로 그 창에서 이어간다 — layout.apply dev"
R=$("$SOK" --window "$ROUTED" layout.apply dev)
say "$R"
OK=$(echo "$R" | jget ok)
[ "$OK" = "True" ] || [ "$OK" = "true" ] || die "layout.apply 실패"
WIN=$(echo "$R" | jget window)
[ "$WIN" = "$ROUTED" ] || die "응답 window 자기표기 불일치: $WIN"

step "3. 데몬 등록 — 응답 hint 가 다음 단계(start·autostart)를 제시하는가"
R=$("$SOK" --window "$ROUTED" daemon.add '{"name":"web","cmd":"node server.mjs"}')
say "$R"
echo "$R" | jget hint | grep -q "daemon.start" || { say "WARN: daemon.add hint 에 start 없음"; FAIL=1; }

step "4. 기동·로그 — 링버퍼로 출력 확인"
R=$("$SOK" --window "$ROUTED" daemon.start web)
say "$R"
sleep 2
R=$("$SOK" --window "$ROUTED" daemon.logs web)
say "$R"
echo "$R" | grep -q "listening 18917" || die "데몬 로그에 기동 흔적 없음"

step "5. daemon.list — 선언+런타임+정책 병합 상태"
R=$("$SOK" --window "$ROUTED" daemon.list)
say "$R"
RUN=$(echo "$R" | jget data daemons 0 running)
[ "$RUN" = "True" ] || [ "$RUN" = "true" ] || die "daemon.list 가 실행 중을 보고하지 않음"

step "6. 스냅샷 — 시각 확인 산출물"
R=$("$SOK" --window "$ROUTED" window.snapshot)
say "$(echo "$R" | head -c 200)"
PNG=$(echo "$R" | jget data path)
[ -n "$PNG" ] && say "스냅샷: $PNG"

step "7. 정리 — 데몬 정지·창 닫기(창 파괴가 데몬을 정리하는 계약도 이 경로로 확인)"
"$SOK" --window "$ROUTED" daemon.stop >/dev/null
"$SOK" --window main window.close "{\"label\":\"$ROUTED\"}" >/dev/null 2>&1 || true
sleep 1
# 데몬 프로세스 잔존 확인
if pgrep -f "node server.mjs" >/dev/null 2>&1; then
  pkill -f "node server.mjs" || true
  die "정지 후 데몬 프로세스 잔존"
fi

say ""
if [ "$FAIL" = "0" ]; then say "PASS: memo-journey 완주 — 응답 정보만으로 헤맴 없음"; else say "PASS(경고 있음): 안내 문구 보강 필요"; exit 2; fi
