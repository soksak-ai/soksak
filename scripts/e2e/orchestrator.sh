#!/bin/bash
# 오케스트레이터 창 E2E — 프로젝트맵 + 핀 + 대화 피드의 회귀 가드.
#   좌측 = 프로젝트 목록(창·모니터 아님): "전체" 항목 + 각 프로젝트. 오케스트레이터 자신은 없다.
#   프로젝트 라벨 클릭 = 피드를 그 프로젝트의 창으로 필터. 우측 아이콘 = 그 창을 앞으로 호출.
#   핀 토글 = always-on-top(on 이면 창을 호출해도 오케스트레이터가 위). 열 때 다른 창 rect 불변.
#   멱등 재열기. 워크스페이스 명령이 활동 피드(대화 버블)에 등장.
#
# 전제: debug 앱 실행 중. 데모 프로젝트를 별도 창에 열고 orch 를 만든 뒤 끝에 정리한다.
# 사용: bash scripts/e2e/orchestrator.sh [--identity debug]
set -uo pipefail
IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
# identity 홈 계약(docs/ARCHITECTURE.md — home.rs·sok CLI 와 동일): app=~/.soksak, 그 외 -<identity>.
if [ "$IDENTITY" = "app" ]; then SOKSAK_E2E_HOME="$HOME/.soksak"; else SOKSAK_E2E_HOME="$HOME/.soksak-$IDENTITY"; fi

export OR_SOCK="$SOKSAK_E2E_HOME/com.soksak.$IDENTITY.sock"

python3 - <<'PYEOF'
import json, os, socket, sys, time
SOCK = os.environ["OR_SOCK"]
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
    # 표준 응답 봉투 {ok,code,message,data}: data 를 최상위로 펼쳐 기존 접근(r["labels"] 등) 유지.
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return {**resp["data"], **{k: v for k, v in resp.items() if k != "data"}}
    return resp
def wins(): return {w["label"]: w for w in rpc("window.monitors")["windows"]}
def nodes(orch, sub):
    return [n["address"].split("/")[-1] for n in rpc("ui.tree", window=orch).get("nodes", [])
            if sub in n.get("address","")]

try: rpc("window.list", t=5)
except Exception: print("FAIL: 앱 소켓 없음 — debug 앱 실행 필요"); sys.exit(1)

# 데모 프로젝트를 별도 창에(전용 프리픽스). 이미 열려 있으면 그 창을 재사용(P6).
demo = "/private/tmp/soksak-e2e-orch-demo"
os.makedirs(demo, exist_ok=True)
r = rpc("window.new", {"root": demo}); time.sleep(3)
w_demo = r.get("label") or r.get("existingWindow")

# 잔재 orch 정리(멱등)
for l in [x for x in rpc("window.list")["labels"] if x.startswith("orch-")]:
    rpc("window.close", {"label": l}); time.sleep(0.4)

# 기준: 열기 전 main rect
before = wins()["main"]; before_rect = (before["x"], before["y"], before["w"], before["h"])

# 열기
res = rpc("window.new", {"mode": "orchestrator"}); orch = res.get("label") or res.get("existingWindow")
(ok if orch and orch.startswith("orch-") else ng)(f"별도 OS 창 생성: {orch}")
time.sleep(4)
w = wins()
(ok if orch in w else ng)("window.list에 orch 등재")

# (c) 열 때 main rect 불변(자동 배치 없음)
after_rect = (w["main"]["x"], w["main"]["y"], w["main"]["w"], w["main"]["h"])
(ok if after_rect == before_rect else ng)(f"(c) 열 때 main rect 불변: {before_rect}=={after_rect}")

# (a) 좌측 = 프로젝트 목록: "전체"(all) + 데모 프로젝트. 오케스트레이터 자신은 없다.
projs = nodes(orch, "/orch/proj/")
(ok if "all" in projs else ng)(f"(a) 좌측에 '전체' 항목: {projs}")
(ok if "soksak-e2e-orch-demo" in projs else ng)(f"(a) 데모 프로젝트가 목록에: {projs}")
(ok if not any(p.startswith("orch-") for p in projs) else ng)("(a) 오케스트레이터 자신은 목록에 없음")

# (b) 창호출 아이콘(우측) → 그 프로젝트의 창을 앞으로. 핀 off 라 그 창이 focus 된다.
calls = nodes(orch, "/orch/proj-call/")
(ok if "soksak-e2e-orch-demo" in calls else ng)(f"(b) 프로젝트에 창호출 아이콘: {calls}")
call_addr = next((n["address"] for n in rpc("ui.tree", window=orch).get("nodes", [])
                  if n.get("address","").endswith("/orch/proj-call/soksak-e2e-orch-demo")), None)
if call_addr:
    rpc("ui.input.click", {"address": call_addr}, orch)
    foc = []
    for _ in range(8):
        time.sleep(0.35)
        foc = [l for l, x in wins().items() if x.get("focused")]
        if foc == [w_demo]: break
    (ok if foc == [w_demo] else ng)(f"(b) 창호출 아이콘 → 그 창 앞으로(핀 off): focused={foc}")
else: ng("창호출 아이콘 노드 없음")

# (b) 핀 토글 = always-on-top on/off
(ok if w[orch].get("alwaysOnTop") is False else ng)("(b) 핀 기본 off")
rpc("ui.input.click", {"address": f"win/{orch}/chrome/orch/pin"}, orch); time.sleep(0.8)
(ok if wins()[orch].get("alwaysOnTop") is True else ng)("(b) 핀 클릭 → always-on-top on")
rpc("ui.input.click", {"address": f"win/{orch}/chrome/orch/pin"}, orch); time.sleep(0.6)
(ok if wins()[orch].get("alwaysOnTop") is False else ng)("(b) 핀 재클릭 → off")

# 프로젝트 라벨 클릭 = 피드 필터(에러 없이 동작 + 재클릭으로 전체 복귀는 UI 상태)
lbl = next((n["address"] for n in rpc("ui.tree", window=orch).get("nodes", [])
            if n.get("address","").endswith("/orch/proj/soksak-e2e-orch-demo")), None)
(ok if lbl else ng)("프로젝트 라벨 노드 존재(피드 필터 대상)")
if lbl: rpc("ui.input.click", {"address": lbl}, orch); time.sleep(0.4)

# 멱등 재열기
r2 = rpc("window.new", {"mode": "orchestrator"})
(ok if r2.get("existingWindow") == orch else ng)(f"멱등 재열기 → existingWindow={r2.get('existingWindow')}")

# 워크스페이스 명령이 활동 피드(대화 버블)에 — 시작/종료/결과가 payload 에 실린다
rpc("state.tree", window="main"); time.sleep(0.6)
recent = rpc("activity.recent", {"limit": 20}).get("entries", [])
ce = [e for e in recent if e["kind"] == "command.executed"]
(ok if ce else ng)("워크스페이스 명령이 활동 피드에 등장")
if ce:
    p = ce[-1]["payload"]
    (ok if ("startedAt" in p and "finishedAt" in p and "message" in p) else ng)(
        f"(피드) 대화 버블 데이터(시작/종료/결과) 존재: {sorted(p.keys())}")

# 정리
rpc("window.close", {"label": orch}); time.sleep(0.4)
for pr in rpc("state.tree", window=w_demo).get("projects", []):
    if "soksak-e2e-orch-demo" in pr["root"]:
        rpc("project.close", {"project": pr["id"]}, w_demo); time.sleep(0.3)

print()
print(f"orchestrator: PASS={len(PASS)} FAIL={len(FAIL)}")
sys.exit(0 if not FAIL else 1)
PYEOF
