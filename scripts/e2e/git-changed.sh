#!/bin/bash
# git.changed E2E (P1 게이트 ⑧) — 외부 프로세스의 커밋이 git-core 플러그인의
# 저장소 감시를 거쳐 git.changed 버스 이벤트로 도달하는지를 판정한다.
#   픽스처 repo 창 열기 → git-core watch.start → 별도 프로세스에서 파일 커밋 →
#   프로브 플러그인이 git.changed(kind=refs·meta, root 일치) 수신 단언.
#
# 버스 이벤트는 창-로컬이라 소켓 스트림(sok events)으로 관측할 수 없다 —
# fixtures/soksak-plugin-gitchanged-probe 가 대상 창 안에서 수신을 기록한다.
# watch.start 는 실패 시 커맨드 실패다(무음 폴백 없음) — ok:true 를 함께 단언한다.
#
# 전제: git-core 플러그인이 identity 플러그인 홈에 설치되어 있어야 한다(외부 repo
# 산출물이라 이 하니스가 만들어내지 않는다 — 부재면 RED 로 종료).
# 멱등: 전용 픽스처 root(~/.soksak-e2e/git-changed-fixture)와 창 1개 안에서만 동작,
# 종료 시 watch.stop + 창 닫기. 앱은 이 하니스가 직접 기동한다(pty-survival 선례).
#
# 사용: bash scripts/e2e/git-changed.sh [--identity debug]
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
PROBE_SRC="$ROOT_DIR/scripts/e2e/fixtures/soksak-plugin-gitchanged-probe"

[ -x "$APP_BIN" ] || { echo "RED: 앱 번들 없음(make build-debug 먼저): $APP_BIN" >&2; exit 1; }
[ -f "$PLUGIN_HOME/soksak-plugin-git-core/plugin.json" ] || {
  echo "RED: git-core 플러그인 미설치($PLUGIN_HOME/soksak-plugin-git-core) — 이관판을 먼저 배포하라" >&2; exit 1; }

# 프로브 픽스처 동기화(멱등)
mkdir -p "$PLUGIN_HOME/soksak-plugin-gitchanged-probe"
cp "$PROBE_SRC/plugin.json" "$PROBE_SRC/main.js" "$PLUGIN_HOME/soksak-plugin-gitchanged-probe/"

export GC_SOCK="$SOCK" GC_APP_BIN="$APP_BIN" GC_IDENTITY="$IDENTITY"
python3 - <<'PYEOF'
import json, os, socket, subprocess, sys, time

SOCK = os.environ["GC_SOCK"]; APP_BIN = os.environ["GC_APP_BIN"]
IDENTITY = os.environ["GC_IDENTITY"]
E2E_HOME = os.path.join(os.environ["HOME"], ".soksak-e2e")
FIX = os.path.join(E2E_HOME, "git-changed-fixture")
GITCORE = "soksak-plugin-git-core"
PROBE = "soksak-plugin-gitchanged-probe"

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
    log = open("/dev/null", "ab")
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

def git(*args):
    return subprocess.run(["git", "-C", FIX, *args], capture_output=True, text=True)

# ── 0. 픽스처 repo(멱등) + 하니스 소유 앱 기동 ──────────────────────────────
os.makedirs(FIX, exist_ok=True)
if not os.path.isdir(os.path.join(FIX, ".git")):
    subprocess.run(["git", "init", "-q", FIX], check=True)
    git("commit", "--allow-empty", "-m", "fixture root")
if app_alive():
    print("  기존 앱 인스턴스 감지 — 종료 후 하니스 소유로 재기동")
    terminate()
launch()

# 잔재 픽스처 창 정리(멱등 재실행)
for l in rpc("window.list").get("labels", []):
    if not str(l).startswith("w-"): continue
    try:
        tr = rpc("state.tree", window=l, timeout=4)
        if any("git-changed-fixture" in str(p.get("root", "")) for p in tr.get("projects", [])):
            rpc("window.close", {"label": l}); time.sleep(0.5)
    except Exception:
        pass

# ── 1. 프로브 동의 + 픽스처 창 ──────────────────────────────────────────────
try: rpc("plugin.consent.grant", {"plugin": PROBE})
except Exception: pass  # 이미 동의된 경우
r = rpc("window.open", {"root": FIX}); time.sleep(5)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"창 생성 실패: {r}"
print(f"  창={WIN} 픽스처={FIX}")

# ── 2. watch.start — 무음 폴백 부재 단언(실패는 커맨드 실패여야 한다) ─────────
w = rpc(f"plugin.{GITCORE}.watch.start", {"path": FIX}, window=WIN)
if w.get("ok") and (w.get("watching") or w.get("already")):
    ok(f"watch.start ok — watching={w.get('watching')}")
else:
    ng(f"watch.start 실패: {w}")

# ── 3. 외부 프로세스 커밋 → git.changed 수신 판정 ────────────────────────────
marker = f"gc-{os.getpid()}-{int(time.time())}"
open(os.path.join(FIX, "probe.txt"), "a").write(marker + "\n")
git("add", "probe.txt")
c = git("commit", "-m", f"external commit {marker}")
assert c.returncode == 0, f"외부 커밋 실패: {c.stderr}"
print(f"  외부 커밋 완료({marker})")

seen = []
deadline = time.time() + 15  # 이벤트 도달 대기(디바운스 포함) — 상한 15s
while time.time() < deadline:
    time.sleep(1)
    try:
        d = rpc(f"plugin.{PROBE}.dump", window=WIN)
        seen = d.get("seen", [])
        kinds = {e.get("payload", {}).get("kind") for e in seen}
        if {"refs", "meta"} <= kinds: break
    except Exception:
        pass

kinds = sorted({str(e.get("payload", {}).get("kind")) for e in seen})
roots = {os.path.realpath(str(e.get("payload", {}).get("root", ""))) for e in seen}
if seen: ok(f"git.changed {len(seen)}건 수신(kinds={kinds})")
else: ng("git.changed 미수신(15s)")
if "refs" in kinds: ok("kind=refs (브랜치 tip 갱신) 수신")
else: ng(f"kind=refs 부재(수신 kinds={kinds})")
if "meta" in kinds: ok("kind=meta (HEAD/index) 수신")
else: ng(f"kind=meta 부재(수신 kinds={kinds})")
if roots and roots <= {os.path.realpath(FIX)}: ok("payload.root = 픽스처 root 일치")
elif roots: ng(f"payload.root 불일치: {roots}")

# ── 4. 정리(멱등) ────────────────────────────────────────────────────────────
try:
    rpc(f"plugin.{GITCORE}.watch.stop", {"path": FIX}, window=WIN)
    rpc("window.close", {"label": WIN}); time.sleep(1)
    rpc("project.recent.remove", {"root": FIX})
except Exception:
    pass
terminate()

print()
print(f"git-changed: PASS={len(PASS)} FAIL={len(FAIL)}")
sys.exit(0 if not FAIL else 1)
PYEOF
