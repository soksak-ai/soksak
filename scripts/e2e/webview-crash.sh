#!/bin/bash
# webview 크래시 복구 E2E (W6 M4) — 렌더러 프로세스 kill -9 주입으로 서킷 브레이커의
# 실물 경로를 판정한다. 시나리오(플랜 §5.5 W6 M4):
#   ① 1회 kill → 자동 복구(webview.crash.recovering→recovered activity) + health closed
#   ② 3연속 kill(윈도우 내 4번째 크래시) → Open(webview.crash.exhausted) + health open
#      → webview.recover 수동 복구 → health closed + 표면 재렌더.
# Open 배지는 window.snapshot PNG 로 캡처해 사람이 눈검증한다(R3) — 캡처 실패는 RED.
#
# 렌더러 식별: macOS WebContent 는 launchd 소생(ppid=1)이라 pgrep -P 로 못 찾는다.
# 대상 뷰를 여는 행위 전후의 WebContent pid 집합 차분이 대상 렌더러다 — 주입 후
# soksak activity 이벤트 도달이 소속을 재확인한다(무반응이면 RED).
#
# 픽스처: fixtures/soksak-plugin-e2e-surface — 네이티브 child webview(b-<win>-<view>)
# 한 장을 콘텐츠 뷰로 임베드한다. 하니스가 플러그인 홈에 동기화하고 동의·활성화한다.
# 멱등: 전용 root(~/.soksak-e2e/webview-crash) 창 1개 안에서만 동작, 종료 시 창 닫기.
# 앱은 이 하니스가 직접 기동한다(pty-survival 선례).
#
# 사용: bash scripts/e2e/webview-crash.sh [--identity debug]   (KEEP=1: 캡처 보존)
set -uo pipefail

IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_DIR="$(cd "$ROOT_DIR/src-tauri" && cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['target_directory'])")"
APP_BUNDLE="$TARGET_DIR/debug/bundle/macos/soksak-$IDENTITY.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/soksak-$IDENTITY"
if [ "$IDENTITY" = "app" ]; then E2E_APP_HOME="$HOME/.soksak"; else E2E_APP_HOME="$HOME/.soksak-$IDENTITY"; fi
SOCK="$E2E_APP_HOME/com.soksak.$IDENTITY.sock"
PLUGIN_HOME="$E2E_APP_HOME/plugins"
FIXTURE_SRC="$ROOT_DIR/scripts/e2e/fixtures/soksak-plugin-e2e-surface"

[ -x "$APP_BIN" ] || { echo "RED: 앱 번들 없음(make build-debug 먼저): $APP_BIN" >&2; exit 1; }

# 픽스처 동기화(멱등)
mkdir -p "$PLUGIN_HOME/soksak-plugin-e2e-surface"
cp "$FIXTURE_SRC/plugin.json" "$FIXTURE_SRC/main.js" "$PLUGIN_HOME/soksak-plugin-e2e-surface/"

export WC_SOCK="$SOCK" WC_APP_BIN="$APP_BIN" WC_IDENTITY="$IDENTITY" WC_KEEP="${KEEP:-0}"
python3 - <<'PYEOF'
import base64, json, os, re, signal, socket, subprocess, sys, time

SOCK = os.environ["WC_SOCK"]; APP_BIN = os.environ["WC_APP_BIN"]
IDENTITY = os.environ["WC_IDENTITY"]; KEEP = os.environ["WC_KEEP"] == "1"
E2E_HOME = os.path.join(os.environ["HOME"], ".soksak-e2e")
ROOT = os.path.join(E2E_HOME, "webview-crash")
TMP = os.path.join(E2E_HOME, "webview-crash-artifacts")
FIXTURE = "soksak-plugin-e2e-surface"
os.makedirs(ROOT, exist_ok=True); os.makedirs(TMP, exist_ok=True)

PASS = []; FAIL = []
def ok(m): PASS.append(m); print(f"  GREEN: {m}")
def ng(m): FAIL.append(m); print(f"  RED:   {m}")

def rpc(method, params=None, window=None, timeout=20):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout); s.connect(SOCK)
    req = {"id": 1, "method": method, "params": params or {}}
    if window: req["window"] = window
    s.sendall((json.dumps(req) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(1 << 20)
        if not chunk: raise ConnectionError("소켓 EOF(응답 없이 닫힘)")
        buf += chunk
    s.close()
    resp = json.loads(buf.split(b"\n")[0])
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return {**resp["data"], **{k: v for k, v in resp.items() if k != "data"}}
    return resp

def wait_socket(secs=45):
    for _ in range(secs * 2):
        try:
            rpc("window.list", timeout=5); return True
        except Exception: time.sleep(0.5)
    return False

APP_PAT = f"soksak-{IDENTITY}.app/Contents/MacOS"
def app_alive():
    return subprocess.run(["pgrep", "-f", APP_PAT], capture_output=True).returncode == 0

def launch():
    log = open(os.path.join(TMP, "app.log"), "ab")
    subprocess.Popen([APP_BIN], stdout=log, stderr=log, start_new_session=True)
    assert wait_socket(), "앱 소켓 기동 실패"
    time.sleep(4)

def terminate():
    subprocess.run(["pkill", "-TERM", "-f", APP_PAT])
    for _ in range(60):
        if not app_alive(): break
        time.sleep(0.5)
    if app_alive():
        subprocess.run(["pkill", "-9", "-f", APP_PAT]); time.sleep(1)

def webcontent_pids():
    out = subprocess.run(["pgrep", "-f", "WebKit.WebContent"], capture_output=True, text=True).stdout
    return {int(l) for l in out.split() if l.strip()}

def activity_since(seq, kinds):
    r = rpc("activity.recent", {"limit": 200})
    ents = [e for e in r.get("entries", []) if e.get("seq", 0) > seq and e.get("kind") in kinds]
    return sorted(ents, key=lambda e: e.get("seq", 0))

def last_seq():
    r = rpc("activity.recent", {"limit": 1})
    ents = r.get("entries", [])
    return ents[0].get("seq", 0) if ents else 0

def health_of(label):
    r = rpc("webview.health.query")
    for e in r.get("entries", []):
        if e.get("label") == label: return e
    return None

def snapshot(win, name):
    p = os.path.join(TMP, f"{name}.png")
    try:
        r = rpc("window.snapshot", {"base64": True}, window=win)
        png = base64.b64decode(r["media"]["base64"])
        open(p, "wb").write(png)
        print(f"  캡처: {p}")
        return p
    except Exception as e:
        ng(f"캡처 실패({name}): {e}")
        return None

def wait_activity(seq, kind, label=None, secs=20):
    """seq 이후 kind(+label) 이벤트 도달 대기 — 상한 secs, 도달 시 이벤트 반환."""
    for _ in range(secs * 2):
        time.sleep(0.5)
        for e in activity_since(seq, {kind}):
            pl = e.get("payload", {})
            if label is None or pl.get("label") == label:
                return e
    return None

# ── 0. 하니스 소유 앱 기동 + 잔재 창 정리 ────────────────────────────────────
if app_alive():
    print("  기존 앱 인스턴스 감지 — 종료 후 하니스 소유로 재기동")
    terminate()
launch()
for l in rpc("window.list").get("labels", []):
    if not str(l).startswith("w-"): continue
    try:
        tr = rpc("state.tree", window=l, timeout=4)
        if any("webview-crash" in str(p.get("root", "")) for p in tr.get("projects", [])):
            rpc("window.close", {"label": l}); time.sleep(0.5)
    except Exception:
        pass

# ── 1. 픽스처 동의·창·표면 뷰 ────────────────────────────────────────────────
r = rpc("window.open", {"root": ROOT}); time.sleep(5)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"창 생성 실패: {r}"
# 동의·활성화는 대상 창의 스토어에 함께 보낸다 — 동의 기록의 창간 전파(authority
# hydrate)가 비동기라 다른 창에 준 동의가 즉시 안 보인다. 부팅 정착까지 재시도.
enabled = False
for _ in range(15):
    rpc("plugin.consent.grant", {"id": FIXTURE}, window=WIN)
    e = rpc("plugin.enable", {"id": FIXTURE}, window=WIN)
    if e.get("ok"): enabled = True; break
    time.sleep(1)
assert enabled, f"픽스처 활성화 실패: {e}"
time.sleep(2)

before = webcontent_pids()
v = rpc("view.open", {"program": "e2esurface"}, window=WIN)
assert v.get("ok"), f"표면 뷰 열기 실패: {v}"
time.sleep(5)
after = webcontent_pids()
fresh = sorted(after - before)
print(f"  창={WIN} 새 렌더러 후보={fresh}")
assert fresh, "표면 뷰를 열었는데 새 WebContent 프로세스가 없음(측정 무효)"
target = fresh[-1]
snapshot(WIN, "surface-live")

def kill_and_wait_recover(seq, nth):
    """대상 렌더러 kill -9 → recovering activity 의 label 을 얻고, 새 렌더러 pid 를 돌려준다."""
    pre = webcontent_pids()
    os.kill(kill_and_wait_recover.target, signal.SIGKILL)
    ev = wait_activity(seq, "webview.crash.recovering")
    if not ev: return None, None
    label = ev.get("payload", {}).get("label")
    # 복구 reload 후 새 렌더러 pid 채집(다음 주입 대상)
    for _ in range(20):
        time.sleep(0.5)
        fresh = sorted(webcontent_pids() - pre)
        if fresh:
            kill_and_wait_recover.target = fresh[-1]
            break
    return ev, label

kill_and_wait_recover.target = target

# ── 2. ① 1회 kill → 자동 복구 + activity + health closed ────────────────────
seq = last_seq()
ev, LABEL = kill_and_wait_recover(seq, 1)
if ev:
    pl = ev.get("payload", {})
    ok(f"kill#1 → webview.crash.recovering(label={LABEL}, attempt={pl.get('attempt')}, target={pl.get('target')})")
else:
    ng("kill#1 → recovering activity 미도달(20s) — 주입이 브레이커에 닿지 않음")
    LABEL = None
if LABEL:
    done = wait_activity(seq, "webview.crash.recovered", label=LABEL)
    if done: ok(f"kill#1 → webview.crash.recovered(attempt={done['payload'].get('attempt')})")
    else: ng("kill#1 → recovered activity 미도달(20s)")
    h = health_of(LABEL)
    if h and h.get("state") == "closed" and h.get("totalCrashes", 0) >= 1:
        ok(f"health: state=closed totalCrashes={h.get('totalCrashes')}")
    else:
        ng(f"health 불일치(기대 closed/≥1): {h}")

# ── 3. ② 3연속 kill → Open(webview.crash.exhausted) ────────────────────────
if LABEL:
    exhausted = None
    for n in (2, 3, 4):
        seq = last_seq()
        pre = webcontent_pids()
        try: os.kill(kill_and_wait_recover.target, signal.SIGKILL)
        except ProcessLookupError:
            ng(f"kill#{n}: 대상 렌더러 pid 소실"); break
        ev = wait_activity(seq, "webview.crash.recovering", label=LABEL, secs=15)
        exh = None if ev else wait_activity(seq, "webview.crash.exhausted", label=LABEL, secs=5)
        if ev:
            print(f"  kill#{n} → recovering(attempt={ev['payload'].get('attempt')})")
            for _ in range(20):
                time.sleep(0.5)
                fresh = sorted(webcontent_pids() - pre)
                if fresh:
                    kill_and_wait_recover.target = fresh[-1]; break
        elif exh:
            exhausted = exh; break
        else:
            ng(f"kill#{n} → recovering/exhausted 어느 쪽도 미도달"); break
    if exhausted:
        ok(f"윈도우 상한 소진 → webview.crash.exhausted(crashesInWindow={exhausted['payload'].get('crashesInWindow')})")
    else:
        ng("webview.crash.exhausted 미도달(4회 크래시 내)")
    h = health_of(LABEL)
    if h and h.get("state") == "open":
        ok(f"health: state=open(수동 복구 대기) crashesInWindow={h.get('crashesInWindow')}")
    else:
        ng(f"health 불일치(기대 open): {h}")
    badge = snapshot(WIN, "breaker-open-badge")  # R3: 사람이 이 PNG 의 배지를 눈검증한다
    if badge: ok("Open 배지 캡처 저장(눈검증 대상)")

# ── 4. webview.recover → 회복 판정 ───────────────────────────────────────────
if LABEL:
    rec = rpc("webview.recover", {"label": LABEL})
    if rec.get("ok"): ok("webview.recover ok")
    else: ng(f"webview.recover 실패: {rec}")
    time.sleep(3)
    h = health_of(LABEL)
    if h is None or h.get("state") == "closed":
        ok(f"recover 후 health closed({'엔트리 소거' if h is None else 'state=closed'})")
    else:
        ng(f"recover 후 health 불일치: {h}")
    snapshot(WIN, "recovered-surface")

# ── 5. 정리(멱등) ────────────────────────────────────────────────────────────
try:
    rpc("window.close", {"label": WIN}); time.sleep(1)
    rpc("project.recent.remove", {"root": ROOT})
except Exception:
    pass
terminate()

print()
print(f"webview-crash: PASS={len(PASS)} FAIL={len(FAIL)}" + (f"  산출물={TMP}" if KEEP or FAIL else ""))
sys.exit(0 if not FAIL else 1)
PYEOF
