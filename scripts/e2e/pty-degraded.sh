#!/bin/bash
# PTY degraded 복원 E2E (터미널 미러 코어 방출) — 복원 사이드카가 미가동이고 봉인 기록도 없을 때
# 소비자 플러그인이 코어 폴백에 기대지 않고 스스로 degraded 를 처리하는지 판정한다. 시나리오:
#   사이드카 바이너리 부재(스폰 실패) → 신선 터미널 스폰 → rehydrate 사망(소켓 없음) → 봉인 없음
#   → degraded-fresh: 화면+활동 loud 고지 + 신선 셸(코어 mirror-replay 폴백 없음) + TypeError 0.
#
# 이 하니스는 deferToCoreRestore 폴백이 살아 있으면 RED 다(고지 없이 코어 복원 신호에 의존).
# 방출 랜딩 후 GREEN — "사이드카 미가동 → 고지 + fresh" 가 이 하니스의 완료 판정이다.
#
# 멱등: 전용 임시 root(~/.soksak-e2e/pty-degraded*) 창 1개, debug identity 홈. 사이드카 바이너리는
# setup 에서 옆으로 치우고(스폰 실패 강제) trap 으로 반드시 복원한다 — 크래시/인터럽트에도 원복.
# 다른 하니스와 동일하게 debug 홈을 앱-kill 로 배타 점유한다(동시 실행 가정 안 함).
#
# 사용: bash scripts/e2e/pty-degraded.sh [--identity debug]   (KEEP=1: 캡처 보존)
#   SOKSAK_TERM_PROGRAM=terminal-ghostty 로 ghostty 엔진도 겨눈다(기본 terminal-xterm).
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
PTYD_BIN="$TARGET_DIR/debug/soksak-ptyd"
# 복원 사이드카 dist 진입점 — 코어 resolve_sidecar_cmd 규격(identity 홈/sidecars/<unit>/dist/<unit>).
SIDECAR_BIN="$E2E_APP_HOME/sidecars/soksak-sidecar-terminal-alacritty/dist/soksak-sidecar-terminal-alacritty"

[ -x "$APP_BIN" ] || { echo "RED: 앱 번들 없음(make build-debug 먼저): $APP_BIN" >&2; exit 1; }

# ── 사이드카 무력화(스폰 실패 강제) + 반드시 복원 ────────────────────────────────
# 직전 크래시로 남았을 수 있는 hidden 을 먼저 원복(멱등), 그다음 옆으로 치운다. trap 은 어떤
# 종료 경로에서도 실물을 제자리로 되돌린다 — 공유 debug 홈을 깨진 채 남기지 않는다.
restore_sidecar() { [ -f "$SIDECAR_BIN.e2ehidden" ] && mv -f "$SIDECAR_BIN.e2ehidden" "$SIDECAR_BIN" 2>/dev/null; return 0; }
trap restore_sidecar EXIT INT TERM
restore_sidecar
[ -f "$SIDECAR_BIN" ] && mv -f "$SIDECAR_BIN" "$SIDECAR_BIN.e2ehidden"
echo "  사이드카 무력화: $([ -f "$SIDECAR_BIN" ] && echo PRESENT || echo HIDDEN)"

export PS_SOCK="$SOCK" PS_APP_BIN="$APP_BIN" PS_KEEP="${KEEP:-0}" PS_PTYD_BIN="$PTYD_BIN"
export PS_PROGRAM="${SOKSAK_TERM_PROGRAM:-terminal-xterm}"
python3 - <<'PYEOF'
import base64, json, os, re, socket, subprocess, sys, time, hashlib

SOCK = os.environ["PS_SOCK"]; APP_BIN = os.environ["PS_APP_BIN"]
KEEP = os.environ["PS_KEEP"] == "1"; PTYD_BIN = os.environ["PS_PTYD_BIN"]
PROGRAM = os.environ["PS_PROGRAM"]
E2E_HOME = os.path.join(os.environ["HOME"], ".soksak-e2e")
ROOT = os.path.join(E2E_HOME, "pty-degraded")        # 창 carrier
PROJ = os.path.join(E2E_HOME, "pty-degraded-proj")   # 대상(신선 터미널 1개)
ALIAS = "pty-degraded-e2e"
TMP = os.path.join(E2E_HOME, "pty-degraded-artifacts")
os.makedirs(ROOT, exist_ok=True); os.makedirs(PROJ, exist_ok=True); os.makedirs(TMP, exist_ok=True)

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
        if not chunk: raise ConnectionError("소켓 EOF")
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

APP_PAT = "soksak-debug.app/Contents/MacOS"
def app_alive():
    return subprocess.run(["pgrep", "-f", APP_PAT], capture_output=True).returncode == 0

def terminate():
    subprocess.run(["pkill", "-TERM", "-f", APP_PAT])
    for _ in range(60):
        if not app_alive(): break
        time.sleep(0.5)
    if app_alive():
        subprocess.run(["pkill", "-9", "-f", APP_PAT]); time.sleep(1)
    # 생존 사이드카/데몬도 리셋 — 신선 기동에서 사이드카가 정말 미가동이도록.
    subprocess.run(["pkill", "-9", "-f", "soksak-debug/sidecars/soksak-sidecar-terminal"])
    subprocess.run(["pkill", "-9", "-f", "soksak-debug/bin/soksak-ptyd"])
    time.sleep(1)

def launch():
    env = dict(os.environ)
    if os.path.exists(PTYD_BIN): env["SOKSAK_PTYD_BIN"] = PTYD_BIN
    log = open(os.path.join(TMP, "app.log"), "wb")
    subprocess.Popen([APP_BIN], env=env, stdout=log, stderr=log, start_new_session=True)
    assert wait_socket(), "앱 소켓 기동 실패"
    time.sleep(4)

def pane_of(win):
    tr = rpc("state.tree", window=win)
    for p in tr.get("projects", []):
        if p.get("alias") == ALIAS or p.get("title") == ALIAS:
            content = next((c for c in p["spaces"] if c.get("active")), p["spaces"][0])
            for g in content.get("panels", []):
                for v in g.get("views", []):
                    if "terminal" in str(v.get("plugin", "")) or v.get("kind") == "terminal":
                        return v.get("focusedPaneId") or v.get("id")
    return None

def term_read(win, pane, lines=60):
    r = rpc("term.read", {"pane": pane, "lines": lines}, window=win)
    return r.get("text") or ""

def exec_and_read(win, pane, cmd, pattern, secs=8):
    rpc("term.exec", {"pane": pane, "cmd": cmd}, window=win)
    for _ in range(secs * 2):
        time.sleep(0.5)
        m = re.search(pattern, term_read(win, pane))
        if m: return m
    return None

def snapshot(win, name):
    # 가려진 창은 rAF 정지(WKWebView) → 캡처가 정지 프레임. 전면화 후 렌더 프레임 갱신을 확인하고 담는다.
    try: rpc("window.focus", {"label": win})
    except Exception: pass
    last = None; png = None
    for _ in range(12):
        time.sleep(0.25)
        try:
            r = rpc("window.snapshot", {"base64": True}, window=win)
            png = base64.b64decode(r["media"]["base64"])
        except Exception as e:
            print(f"  캡처 실패({name}): {e}"); return
        h = hashlib.md5(png).hexdigest()
        if last is not None and h != last: break
        last = h
    p = os.path.join(TMP, f"{name}.png"); open(p, "wb").write(png)
    print(f"  캡처: {p}")

def activity_kinds(limit=60):
    act = rpc("activity.recent", {"limit": limit})
    entries = act.get("entries") or []
    kinds = [e.get("kind", "") for e in entries if isinstance(e, dict)]
    blob = " ".join(json.dumps(e, ensure_ascii=False) for e in entries if isinstance(e, dict))
    return kinds, blob

# ── 0. 준비: 사이드카 미가동 상태로 신선 기동 ────────────────────────────────────
if app_alive():
    print("  기존 debug 앱 감지 — 종료 후 하니스 소유로 재기동"); terminate()
launch()
for l in rpc("window.list").get("labels", []):
    if str(l).startswith("w-"):
        try:
            tr = rpc("state.tree", window=l, timeout=4)
            if any("pty-degraded" in str(p.get("root", "")) for p in tr.get("projects", [])):
                rpc("window.close", {"label": l}); time.sleep(0.5)
        except Exception: pass

# ── 1. 창 + 신선 터미널(복원할 것 없음, 사이드카 미가동) ──────────────────────────
r = rpc("window.open", {"root": ROOT}); time.sleep(4)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"창 생성 실패: {r}"
created = rpc("project.open", {"root": PROJ, "alias": ALIAS, "program": PROGRAM}, window=WIN)
assert created.get("ok"), f"project.open 실패: {created}"
time.sleep(5)  # 마운트 + orchestrateRestore(rehydrate 사망 → degraded-fresh) 정착
pane = pane_of(WIN)
assert pane, "터미널 pane 을 찾지 못함"
print(f"  창={WIN} pane={pane} program={PROGRAM}")

# ── 2. degraded-fresh 판정 ───────────────────────────────────────────────────
text = term_read(WIN, pane, lines=60)
NOTICE = "복원 서비스 미가동"
if NOTICE in text: ok("degraded: 화면에 loud 고지(무음 아님)")
else: ng(f"degraded: 화면 고지 부재 — 버퍼 발췌 {text[:120]!r}")

kinds, blob = activity_kinds()
if any("restore.degraded-fresh" in k for k in kinds): ok("degraded: 활동 로그 고지(terminal.restore.degraded-fresh)")
else: ng(f"degraded: 활동 고지 부재 — kinds {sorted(set(kinds))[:12]}")
if any("sidecar" in k and "spawn-failed" in k for k in kinds): ok("degraded: 사이드카 스폰 실패도 고지")
else: ng("degraded: 사이드카 스폰 실패 미고지")

# 코어 폴백 방출 확인: TypeError/undefined 크래시·boot.error 가 없어야 한다(무너지지 않고 degraded).
if any("boot.error" in k for k in kinds): ng(f"degraded: boot.error 발생 — {blob[:200]}")
else: ok("degraded: boot.error 없음")
if ("TypeError" in blob) or ("is not a function" in blob) or ("Cannot read" in blob):
    ng(f"degraded: 런타임 크래시 흔적 — {blob[:200]}")
else: ok("degraded: TypeError/undefined 크래시 없음")

# ── 3. 신선 셸이 실제로 산다(복원은 없어도 라이브는 동작) ─────────────────────────
m = exec_and_read(WIN, pane, "echo PDEGR_LIVE=$$", r"PDEGR_LIVE=(\d+)")
if m: ok(f"degraded: 신선 셸 라이브 동작(pid {m.group(1)})")
else: ng("degraded: 신선 셸이 명령에 응답 안 함")

snapshot(WIN, "degraded-fresh")

# ── 4. 정리(멱등) ────────────────────────────────────────────────────────────
if not KEEP:
    try: rpc("window.close", {"label": WIN})
    except Exception: pass
    terminate()

n = len(PASS); f = len(FAIL)
print(f"pty-degraded: PASS={n} FAIL={f}  산출물={TMP}")
sys.exit(1 if f else 0)
PYEOF
rc=$?
# trap 이 사이드카를 복원한다. 명시 로그로 원복 확인.
restore_sidecar
echo "  사이드카 복원: $([ -f "$SIDECAR_BIN" ] && echo PRESENT || echo MISSING)"
exit $rc
