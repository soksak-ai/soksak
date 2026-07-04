#!/bin/bash
# 프로젝트 레일 + 픽커 E2E — 멱등·반복 가능(내재화). 검증(사용자 지적 원천):
#   ① 레일 최근칩: 안 열린 최근 프로젝트가 레일에 나열된다(픽커 전용이 아님).
#   ② 최근칩 클릭 = 이 창에서 열기, 그리고 "나머지 최근칩은 유지된다"(하나 클릭에 전부
#      사라지지 않음 — 사용자 관찰의 반증).
#   ③ 픽커 클릭 실경로: 픽커 항목의 실좌표에서 elementFromPoint 가 picker-item 에 닿는다
#      (빈 terminal-stack 오버레이가 클릭을 가로채지 않음 — z-index 회귀 가드).
#   ④ 타창 프로젝트: 다른 창에 연 프로젝트가 이 창 레일에 뜨고, 클릭=그 창 포커스(P6).
#
# 멱등: 전용 임시 root(/tmp/soksak-rail-{a,b,c})만 만지고, 시작 시 잔재를 청소하며, 끝에
# 생성분(창·탭)을 닫고 recentProjects kv 에서 이 테스트 root 만 제거한다(사용자 실 최근 무접촉).
#
# 사용: bash scripts/e2e/project-rail.sh [--identity debug]
set -uo pipefail
IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
# identity 홈 계약(docs/ARCHITECTURE.md — home.rs·sok CLI 와 동일): app=~/.soksak, 그 외 -<identity>.
if [ "$IDENTITY" = "app" ]; then SOKSAK_E2E_HOME="$HOME/.soksak"; else SOKSAK_E2E_HOME="$HOME/.soksak-$IDENTITY"; fi

export PR_SOCK="$SOKSAK_E2E_HOME/com.soksak.$IDENTITY.sock"

python3 - <<'PYEOF'
import json, os, socket, sys, time

SOCK = os.environ["PR_SOCK"]
PASS = []; FAIL = []
def ok(m): PASS.append(m); print(f"  ✓ {m}")
def ng(m): FAIL.append(m); print(f"  ✗ {m}")
def rpc(method, params=None, window="main", t=25):
    s = socket.socket(socket.AF_UNIX); s.settimeout(t); s.connect(SOCK)
    s.sendall((json.dumps({"id":1,"method":method,"params":params or {},"window":window})+"\n").encode())
    buf=b""
    while b"\n" not in buf: buf+=s.recv(1<<20)
    s.close()
    resp = json.loads(buf.split(b"\n")[0])
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return {**resp["data"], **{k: v for k, v in resp.items() if k != "data"}}
    return resp

def rail_recents(window="main"):
    return [n["address"].split("/")[-1] for n in rpc("ui.tree", window=window).get("nodes", [])
            if "/rail/recent/" in n.get("address", "")]
def rail_others(window="main"):
    return [n["address"].split("/")[-1] for n in rpc("ui.tree", window=window).get("nodes", [])
            if "/rail/other/" in n.get("address", "")]
def node(addr_suffix, window="main"):
    for n in rpc("ui.tree", window=window).get("nodes", []):
        if n.get("address","").endswith(addr_suffix): return n["address"]
    return None
def roots(window="main"):
    return [p["root"] for p in rpc("state.tree", window=window).get("projects", [])]

try: rpc("window.list", t=5)
except Exception: print("FAIL: 앱 소켓 없음 — debug 앱 실행 필요"); sys.exit(1)

for x in "abc": os.makedirs("/tmp/soksak-rail-"+x, exist_ok=True)
# macOS /tmp → /private/tmp 심볼릭 — 코어가 canonicalize 하므로 realpath 로 비교한다.
ra, rb, rc = [os.path.realpath("/tmp/soksak-rail-"+x) for x in "abc"]
def rp(lst): return [os.path.realpath(x) for x in lst]

# ── 청소(멱등): 이전 실행/세션이 남긴 테스트 창·탭(rail-* + e2e 잔재) ──
TESTMARK = ("soksak-rail", "soksak-e2e")
def is_test(root): return any(m in root for m in TESTMARK)
for l in [x for x in rpc("window.list")["labels"] if x.startswith("win-")]:
    try:
        if any(is_test(p.get("root","")) for p in rpc("state.tree", window=l).get("projects", [])):
            rpc("window.close", {"label": l}); time.sleep(0.4)
    except Exception: pass
for p in rpc("state.tree").get("projects", []):
    if is_test(p["root"]): rpc("project.close", {"project": p["id"]}); time.sleep(0.3)

# ── ① 최근 3개 쌓기(열었다 닫기) → 레일 최근칩 노출 ──
for r in (ra, rb, rc):
    pid = rpc("project.create", {"root": r}).get("projectId"); time.sleep(0.5)
    rpc("project.close", {"project": pid}); time.sleep(0.4)
time.sleep(0.6)
rec = rail_recents()
if all(f"soksak-rail-{x}" in rec for x in ("a","b","c")):
    ok(f"레일 최근칩 노출: {rec}")
else: ng(f"레일 최근칩 누락: {rec}")

# ── ② 최근칩 하나 클릭 → 열림 + 나머지 유지 ──
before = roots()
addr = node("/rail/recent/soksak-rail-a")
if addr:
    rpc("ui.input.click", {"address": addr}); time.sleep(1.5)
    after = rp(roots()); rec2 = rail_recents()
    if ra in after and ra not in rp(before): ok("최근칩 클릭 → 이 창에서 열림")
    else: ng(f"최근칩 클릭이 열지 못함: {after}")
    if "soksak-rail-a" not in rec2 and "soksak-rail-b" in rec2 and "soksak-rail-c" in rec2:
        ok("나머지 최근칩 유지(하나 클릭에 전부 사라지지 않음)")
    else: ng(f"나머지 최근칩 소실: {rec2}")
else: ng("최근칩 노드 없음")

# ── ③ 픽커 클릭 실경로(빈 창의 픽커) ──
wp = rpc("window.new").get("label"); time.sleep(3)
items = [n for n in rpc("ui.tree", window=wp).get("nodes", []) if "/picker/item/" in n.get("address","")]
if items:
    mons = rpc("window.monitors"); w = [x for x in mons["windows"] if x["label"] == wp][0]
    scale = mons["monitors"][w.get("monitor") or 0]["scale"]
    cx = int(w["w"]/scale/2)
    H = w["h"]/scale
    hits = [rpc("ui.hit", {"x": cx, "y": int(H*f)}, wp).get("data", {}).get("node", "") for f in (0.30, 0.35)]
    if any(h.startswith("picker/item/") for h in hits):
        ok(f"픽커 실좌표 hit=picker-item(오버레이 미차단): {hits}")
    else: ng(f"픽커 실좌표가 picker-item 아님(오버레이 차단?): {hits}")
    # 아직 어디에도 안 열린 항목(rail-c — ② 에서 미개방)을 클릭해야 이 픽커 창에 열린다.
    # 이미 열린 항목은 P6 로 소유 창을 포커스하는 게 정상이므로 미개방 항목으로 판정한다.
    opened = False
    for it in items:
        rpc("ui.input.click", {"address": it["address"]}, wp); time.sleep(1.2)
        if rc in rp(roots(wp)): opened = True; break
    (ok if opened else ng)("픽커 항목 클릭 → 이 창에서 열림(미개방 항목)")
else: ng("픽커 항목 없음")
rpc("window.close", {"label": wp}); time.sleep(0.5)

# ── ④ 타창 프로젝트가 이 창 레일에 + 클릭=그 창 포커스 ──
wo = rpc("window.new", {"root": rb}).get("label"); time.sleep(4)  # rb 를 별도 창에
others = rail_others()
if "soksak-rail-b" in others:
    ok(f"타창 프로젝트가 레일에 노출: {others}")
    oaddr = node("/rail/other/soksak-rail-b")
    rpc("ui.input.click", {"address": oaddr})
    foc = []
    for _ in range(10):  # OS 포커스 반영은 비동기 — is_focused 갱신을 잠깐 기다린다
        time.sleep(0.4)
        foc = [x["label"] for x in rpc("window.monitors")["windows"] if x["focused"]]
        if foc == [wo]: break
    (ok if foc == [wo] else ng)(f"타창 칩 클릭 → 소유 창 포커스({foc})")
else: ng(f"타창 프로젝트 레일 미노출: {others}")

# ── 정리(멱등): 창·탭 + recents 의 테스트 root ──
rpc("window.close", {"label": wo}); time.sleep(0.5)
for p in rpc("state.tree").get("projects", []):
    if "soksak-rail" in p["root"]: rpc("project.close", {"project": p["id"]}); time.sleep(0.3)
# recents 에서 이 테스트 root 만 제거(project.recent.forget — 정공법, raw sqlite 아님).
for r in (ra, rb, rc):
    rpc("project.recent.forget", {"root": r})

print()
print(f"project-rail: PASS={len(PASS)} FAIL={len(FAIL)}")
sys.exit(0 if not FAIL else 1)
PYEOF
