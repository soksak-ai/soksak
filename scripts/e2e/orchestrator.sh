#!/bin/bash
# 오케스트레이터 창 E2E — 오늘 실물 결함 3개의 회귀 가드(TDD: 수정 전 RED → 지금 GREEN):
#   (a) 창맵 이름 = 프로젝트명(네이티브 라벨 아님).
#   (b) 핀 토글 — 클릭하면 alwaysOnTop on/off, z-order 케이스 2(창맵 클릭→그 창 활성 + orch 앞 유지).
#   (c) 열 때 다른 창(main)의 rect를 임의 변경하지 않는다(자동 배치 제거).
#   + 별도 OS 창 생성(window.list), 멱등 재열기(existingWindow), 워크스페이스 명령이 피드에 등장.
#
# 전제: debug 앱 실행 중. 창을 만들고 끝에 닫는다(멱등). 사용자 프로젝트 무접촉(창만 조작).
# 사용: bash scripts/e2e/orchestrator.sh [--identity debug]
set -uo pipefail
IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
export OR_SOCK="$HOME/.soksak/com.soksak.$IDENTITY.sock"

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
    s.close(); return json.loads(buf.split(b"\n")[0])
def wins(): return {w["label"]: w for w in rpc("window.monitors")["windows"]}

try: rpc("window.list", t=5)
except Exception: print("FAIL: 앱 소켓 없음 — debug 앱 실행 필요"); sys.exit(1)

# 잔재 orch 정리(멱등)
for l in [x for x in rpc("window.list")["labels"] if x.startswith("orch-")]:
    rpc("window.close", {"label": l}); time.sleep(0.4)

# 기준: 열기 전 main rect
before = wins()["main"]
before_rect = (before["x"], before["y"], before["w"], before["h"])

# 열기
r = rpc("window.new", {"mode": "orchestrator"})
orch = r.get("label") or r.get("existingWindow")
(ok if orch and orch.startswith("orch-") else ng)(f"별도 OS 창 생성: {orch}")
time.sleep(4)
w = wins()
(ok if orch in w else ng)("window.list에 orch 등재")

# (c) main rect 불변
after_rect = (w["main"]["x"], w["main"]["y"], w["main"]["w"], w["main"]["h"])
(ok if after_rect == before_rect else ng)(f"(c) 열 때 main rect 불변 (자동 배치 없음): {before_rect}=={after_rect}")

# (a) 창맵 이름 = 프로젝트명 — window.monitors.title이 프로젝트명(main은 활성 프로젝트명)
main_title = w["main"].get("title", "")
(ok if main_title and main_title != "main" else ng)(f"(a) 창 title=프로젝트명(라벨 아님): main→'{main_title}'")
(ok if w[orch].get("title") == "오케스트레이터" else ng)(f"(a) orch title='오케스트레이터': '{w[orch].get('title')}'")

# (a2) 창맵에 오케스트레이터 자신(orch-*)은 노출하지 않는다 — 관찰 도구이지 대상이 아님.
mapnodes = [n["address"] for n in rpc("ui.tree", window=orch).get("nodes", []) if "/orch/win/" in n.get("address","")]
(ok if not any("/orch/win/orch-" in a for a in mapnodes) else ng)(f"(a2) 창맵에 orch 자신 미노출: {[a.split('/')[-1] for a in mapnodes]}")

# (b) 핀 토글: 기본 off → 클릭 → on → 다시 클릭 → off
(ok if w[orch].get("alwaysOnTop") is False else ng)("(b) 핀 기본 off (alwaysOnTop=False)")
rpc("ui.input.click", {"address": f"win/{orch}/chrome/orch/pin"}, orch); time.sleep(0.8)
(ok if wins()[orch].get("alwaysOnTop") is True else ng)("(b) 핀 클릭 → alwaysOnTop=True")
rpc("ui.input.click", {"address": f"win/{orch}/chrome/orch/pin"}, orch); time.sleep(0.8)
(ok if wins()[orch].get("alwaysOnTop") is False else ng)("(b) 핀 재클릭 → alwaysOnTop=False")

# z-order 모델: 핀 off → 창맵 클릭 시 타겟이 앞(깜빡임 없이 항상위로 감쌌다 해제).
#              핀 on  → 창맵 클릭해도 orch 가 위 유지(항상위라 타겟은 뒤에서 활성).
def focused_after_click(node, t=2.0):
    rpc("ui.input.click", {"address": node}, orch)
    end = 0
    while end < 8:  # OS 포커스 반영은 비동기 — 잠깐 대기
        time.sleep(0.35); end += 1
        f = [l for l, x in wins().items() if x.get("focused")]
        if f: return f
    return []
mnode = None
for n in rpc("ui.tree", window=orch).get("nodes", []):
    if n.get("address","").endswith("/orch/win/main"): mnode = n["address"]; break
if mnode:
    # (핀 off) 창맵 클릭 → 타겟(main)이 앞으로. orch 는 뒤로.
    foc = focused_after_click(mnode)
    (ok if foc == ["main"] else ng)(f"(b) 핀 off + 창맵 클릭 → 타겟이 앞으로(깜빡임 없음): focused={foc}")
    # 창 선택 → 피드가 그 창으로 필터(전체 해제 버튼 노출). 전체 클릭 → 필터 해제.
    def has(addr_suffix):
        return any(n.get("address","").endswith(addr_suffix) for n in rpc("ui.tree", window=orch).get("nodes", []))
    (ok if has("/orch/feed-all") else ng)("창 선택 시 피드 필터 활성(전체 해제 버튼 노출)")
    for n in rpc("ui.tree", window=orch).get("nodes", []):
        if n.get("address","").endswith("/orch/feed-all"):
            rpc("ui.input.click", {"address": n["address"]}, orch); break
    time.sleep(0.6)
    (ok if not has("/orch/feed-all") else ng)("전체 클릭 → 필터 해제(버튼 사라짐)")
    # (핀 on) → 창맵 클릭 시 타겟은 focus 되지만 orch 가 always-on-top(시각적 위) 유지.
    # "orch 위"는 key-window(focused)가 아니라 always-on-top level 로 판정한다.
    rpc("ui.input.click", {"address": f"win/{orch}/chrome/orch/pin"}, orch); time.sleep(0.8)
    rpc("ui.input.click", {"address": mnode}, orch); time.sleep(1.3)
    aot = wins()[orch].get("alwaysOnTop")
    (ok if aot is True else ng)(f"(b) 핀 on + 창맵 클릭 → orch always-on-top 유지(시각적 위): alwaysOnTop={aot}")
    rpc("ui.input.click", {"address": f"win/{orch}/chrome/orch/pin"}, orch); time.sleep(0.5)  # 핀 off 복귀
else: ng("창맵 main 노드 없음")

# 멱등 재열기
r2 = rpc("window.new", {"mode": "orchestrator"})
(ok if r2.get("existingWindow") == orch else ng)(f"멱등 재열기 → existingWindow={r2.get('existingWindow')}")

# 워크스페이스 명령이 피드에 — main에서 명령 실행 후 activity에 등장
rpc("state.tree", window="main")  # remote 계측이 activity에 남김
time.sleep(0.6)
recent = rpc("activity.recent", {"limit": 20}).get("entries", [])
(ok if any(e["kind"] == "command.executed" for e in recent) else ng)("워크스페이스 명령이 활동 피드에 등장")

# 정리
rpc("window.close", {"label": orch}); time.sleep(0.5)

print()
print(f"orchestrator: PASS={len(PASS)} FAIL={len(FAIL)}")
sys.exit(0 if not FAIL else 1)
PYEOF
