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
W0 = "main"  # 소켓 확인 후 전용 워크스페이스 창으로 교체된다(main=컨트롤 플레인, 레일 없음)
def rpc(method, params=None, window=None, t=25):
    window = window or W0
    s = socket.socket(socket.AF_UNIX); s.settimeout(t); s.connect(SOCK)
    s.sendall((json.dumps({"id":1,"method":method,"params":params or {},"window":window})+"\n").encode())
    buf=b""
    while b"\n" not in buf:
        chunk=s.recv(1<<20)
        if not chunk: raise ConnectionError("소켓 EOF(응답 없이 닫힘)")
        buf+=chunk
    s.close()
    resp = json.loads(buf.split(b"\n")[0])
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return {**resp["data"], **{k: v for k, v in resp.items() if k != "data"}}
    return resp

def rail_recents(window=None):
    return [n["address"].split("/")[-1] for n in rpc("ui.tree", window=window).get("nodes", [])
            if "/rail/recent/" in n.get("address", "")]
def rail_others(window=None):
    return [n["address"].split("/")[-1] for n in rpc("ui.tree", window=window).get("nodes", [])
            if "/rail/other/" in n.get("address", "")]
def node(addr_suffix, window=None):
    for n in rpc("ui.tree", window=window).get("nodes", []):
        if n.get("address","").endswith(addr_suffix): return n["address"]
    return None
def roots(window=None):
    return [p["root"] for p in rpc("state.tree", window=window).get("projects", [])]

try: rpc("window.list", window="main", t=5)
except Exception: print("FAIL: 앱 소켓 없음 — debug 앱 실행 필요"); sys.exit(1)

for x in "abc": os.makedirs("/tmp/soksak-rail-"+x, exist_ok=True)
# 홈 워크스페이스 창 — 레일·프로젝트 시나리오의 기본 무대(main 은 컨트롤 플레인).
os.makedirs("/tmp/soksak-rail-home", exist_ok=True)
_rh = rpc("window.new", {"root": "/tmp/soksak-rail-home"}, window="main")
W0 = _rh.get("label") or _rh.get("existingWindow"); time.sleep(4)
# macOS /tmp → /private/tmp 심볼릭 — 코어가 canonicalize 하므로 realpath 로 비교한다.
ra, rb, rc = [os.path.realpath("/tmp/soksak-rail-"+x) for x in "abc"]
def rp(lst): return [os.path.realpath(x) for x in lst]

# ── 청소(멱등): 이전 실행/세션이 남긴 테스트 창·탭(rail-* + e2e 잔재) ──
TESTMARK = ("soksak-rail", "soksak-e2e")
def is_test(root): return any(m in root for m in TESTMARK) and "rail-home" not in root
for l in [x for x in rpc("window.list")["labels"] if x.startswith("w-") and x != W0]:
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

# ── ③ 열기·생성의 단일 표면 = 컨트롤 플레인(픽커 소멸) ──
# 빈 워크스페이스 창은 생성 경로가 없다 — root 없는 window.new 는 거부된다.
r_bare = rpc("window.new", window="main")
(ok if r_bare.get("ok") is False and r_bare.get("code") == "INVALID_PARAMS"
 else ng)(f"root 없는 window.new 거부: {r_bare.get('code')}")
# 컨트롤 플레인 프로젝트맵: 미개방 최근(rail-c)의 열기 화살표 클릭 → 새 워크스페이스 창.
addr_c = None
for n in rpc("ui.tree", window="main").get("nodes", []):
    if n.get("address","").endswith("/orch/proj-call/soksak-rail-c"): addr_c = n["address"]; break
if addr_c:
    before_wins = set(rpc("window.list", window="main")["labels"])
    rpc("ui.input.click", {"address": addr_c}, window="main"); time.sleep(4)
    new_wins = set(rpc("window.list", window="main")["labels"]) - before_wins
    opened = False
    for wl in new_wins:
        try:
            if rc in rp(roots(wl)): opened = True; wp = wl; break
        except Exception: pass
    (ok if opened else ng)(f"컨트롤 플레인 열기 화살표 → 새 창에 rail-c 열림({new_wins})")
    if opened: rpc("window.close", {"label": wp}); time.sleep(0.5)
else: ng("컨트롤 플레인 프로젝트맵에 rail-c 화살표 없음")
# 생성 진입점 존재(새 프로젝트 버튼 — 모달 UI 는 시각 검증 영역).
(ok if node("/orch/new-project", window="main") else ng)("컨트롤 플레인에 새 프로젝트 진입점")

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
rpc("window.close", {"label": W0}); time.sleep(0.5)
# recents 에서 이 테스트 root 만 제거(project.recent.forget — 정공법, raw sqlite 아님).
for r in (ra, rb, rc, os.path.realpath("/tmp/soksak-rail-home")):
    rpc("project.recent.forget", {"root": r}, window="main")

print()
print(f"project-rail: PASS={len(PASS)} FAIL={len(FAIL)}")
sys.exit(0 if not FAIL else 1)
PYEOF
