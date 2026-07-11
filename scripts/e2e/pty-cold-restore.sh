#!/bin/bash
# PTY cold byte restore E2E (W5 M4/M5) — 데몬 사망(재부팅 모사) 후 봉인 체크포인트로
# 화면이 복원되는지를 판정한다. 시나리오(플랜 §5.5 M3~M4, P1 게이트 문구):
#   터미널 pane → 스크롤백 마커 → alt-screen TUI(less) → 체크포인트 파일 대기 →
#   디스크 평문 부재 확인 → 앱 종료 + ptyd kill -9(재부팅 모사) → 재기동 복원 →
#   스크롤백 마커 + TUI 내용 + 소실 고지 재현 단언 + window.snapshot 눈검증(R3).
#
# cold restore 랜딩 전에는 반드시 RED 다 — 데몬이 죽으면 세션이 소실되고 새 셸만
# 뜬다(스크롤백·TUI·고지 부재). M4(cold 경로 배선) 후 GREEN 이 완료 판정이다.
#
# vault: SOKSAK_VAULT_PATH(격리 볼트) + SOKSAK_VAULT_KEY(자동 unlock) 오픈 메커니즘.
# 볼트 파일은 런 간 보존한다(삭제 금지) — scope 암호화 키(app.data encryption_keys)가
# 이 볼트의 S 와 짝이라, 볼트를 지우면 다음 런의 unlock 이 R23(키 등록됨+볼트 부재
# = 새 볼트 생성 거부)에 막혀 하니스가 스스로를 오염시킨다(실측). 체크포인트 키
# 캐시(<home>/pty/checkpoint.pub)만 시작·종료 시 정리한다(런 볼트와 재짝지음 — 멱등).
#
# 사용: bash scripts/e2e/pty-cold-restore.sh [--identity debug]   (KEEP=1: 캡처 보존)
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

[ -x "$APP_BIN" ] || { echo "RED: 앱 번들 없음(make build-debug 먼저): $APP_BIN" >&2; exit 1; }
[ -x "$PTYD_BIN" ] || { echo "RED: ptyd 바이너리 없음(cargo build -p soksak-ptyd 먼저): $PTYD_BIN" >&2; exit 1; }

export PS_SOCK="$SOCK" PS_APP_BIN="$APP_BIN" PS_KEEP="${KEEP:-0}" PS_PTYD_BIN="$PTYD_BIN" PS_APP_HOME="$E2E_APP_HOME"
python3 - <<'PYEOF'
import base64, glob, json, os, signal, socket, subprocess, sys, time

SOCK = os.environ["PS_SOCK"]; APP_BIN = os.environ["PS_APP_BIN"]
KEEP = os.environ["PS_KEEP"] == "1"; PTYD_BIN = os.environ["PS_PTYD_BIN"]
APP_HOME = os.environ["PS_APP_HOME"]
E2E_HOME = os.path.join(os.environ["HOME"], ".soksak-e2e")
ROOT = os.path.join(E2E_HOME, "pty-cold")         # 창 carrier
PROJ = os.path.join(E2E_HOME, "pty-cold-proj")    # 터미널 1개 프로젝트
ALIAS = "pty-cold-e2e"
MARK = f"PCOLD{os.getpid()}"
TMP = os.path.join(E2E_HOME, "pty-cold-artifacts")
VAULT = os.path.join(TMP, "vault.json")
for d in (ROOT, PROJ, TMP):
    os.makedirs(d, exist_ok=True)

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

def launch():
    env = dict(os.environ)
    env["SOKSAK_PTYD_BIN"] = PTYD_BIN
    env["SOKSAK_VAULT_PATH"] = VAULT       # 격리 볼트(사용자 실볼트 비오염)
    env["SOKSAK_VAULT_KEY"] = "pty-cold-e2e-pass"  # 자동 unlock(결정적)
    log = open(os.path.join(TMP, "app.log"), "ab")
    subprocess.Popen([APP_BIN], env=env, stdout=log, stderr=log, start_new_session=True)
    assert wait_socket(), "앱 소켓 기동 실패"
    time.sleep(4)

def terminate():
    subprocess.run(["pkill", "-TERM", "-f", APP_PAT])
    for _ in range(60):
        if not app_alive(): break
        time.sleep(0.5)
    if app_alive():
        subprocess.run(["pkill", "-9", "-f", APP_PAT]); time.sleep(1)
    time.sleep(1)

def kill_daemon():
    # 재부팅 모사 — ptyd 를 SIGKILL(정상 종료 경로 없음 → 체크포인트 파일 잔존).
    subprocess.run(["pkill", "-9", "-f", "soksak-ptyd"])
    time.sleep(1)

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

def term_read(win, pane, lines=200):
    r = rpc("term.read", {"pane": pane, "lines": lines}, window=win)
    return r.get("text") or ""

def exec_and_wait(win, pane, cmd, pattern, secs=10):
    rpc("term.exec", {"pane": pane, "cmd": cmd}, window=win)
    for _ in range(secs * 2):
        time.sleep(0.5)
        if pattern in term_read(win, pane):
            return True
    return False

def snapshot(win, name):
    try:
        r = rpc("window.snapshot", {"base64": True}, window=win)
        png = base64.b64decode(r["media"]["base64"])
        p = os.path.join(TMP, f"{name}.png"); open(p, "wb").write(png)
        print(f"  캡처: {p}")
    except Exception as e:
        print(f"  캡처 실패({name}): {e}")

def ckpt_files():
    return glob.glob(os.path.join(APP_HOME, "pty", "checkpoints", "ckpt-*.json"))

def scan_home_for(needle: bytes):
    hits = []
    for base, _dirs, files in os.walk(APP_HOME):
        for f in files:
            p = os.path.join(base, f)
            try:
                with open(p, "rb") as fh:
                    if needle in fh.read():
                        hits.append(p)
            except Exception:
                pass
    return hits

# ── 0. 준비: 잔재 정리(멱등) + 하니스 소유 앱 기동 ───────────────────────────
if app_alive():
    print("  기존 debug 앱 인스턴스 감지 — 종료 후 하니스 소유로 재기동")
    terminate()
kill_daemon()
# 체크포인트 키 캐시·잔여 체크포인트는 이 런의 볼트와 짝을 맞추기 위해 정리한다.
subprocess.run(["rm", "-rf", os.path.join(APP_HOME, "pty")])
launch()

def leftover_windows():
    labs = rpc("window.list").get("labels", [])
    res = []
    for l in labs:
        if not str(l).startswith("w-"): continue
        try:
            tr = rpc("state.tree", window=l, timeout=4)
            if any("pty-cold" in str(p.get("root", "")) for p in tr.get("projects", [])):
                res.append(l)
        except Exception:
            pass
    return res
for l in leftover_windows():
    rpc("window.close", {"label": l}); time.sleep(0.5)

# ── 1. 창 + 터미널 ───────────────────────────────────────────────────────────
r = rpc("window.open", {"root": ROOT}); time.sleep(4)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"창 생성 실패: {r}"
created = rpc("project.open", {"root": PROJ, "alias": ALIAS, "program": "terminal"}, window=WIN)
assert created.get("ok"), f"project.open 실패: {created}"
time.sleep(3)
pane = pane_of(WIN)
assert pane, "터미널 pane 을 찾지 못함"
print(f"  창={WIN} pane={pane}")

# 이 프로젝트 scope 의 app.data 암호화 활성 — command_blocks(의미 축)도 봉인되어야
# "잠금 상태 디스크 평문 부재"가 홈 전체 스캔으로 성립한다(P1 게이트 문구).
enc = rpc("data.encrypt.enable", {"scope": PROJ}, window=WIN)
if enc.get("ok") is False and "이미 암호화" in str(enc.get("message", "")):
    print("  data.encrypt.enable: 이미 활성(이전 런) — 멱등 통과")
elif enc.get("ok") is False:
    ng(f"data.encrypt.enable 실패(볼트 상태 확인): {enc}")
else:
    print("  data.encrypt.enable OK(command_blocks 봉인)")

# ── 2. 스크롤백 마커 + alt-screen TUI ────────────────────────────────────────
assert exec_and_wait(WIN, pane, f"for i in $(seq 1 30); do echo {MARK}-SCROLL-$i; done", f"{MARK}-SCROLL-30"), \
    "스크롤백 마커 미검출"
tui_file = os.path.join(TMP, "tui.txt")
with open(tui_file, "w") as f:
    for i in range(1, 11):
        f.write(f"{MARK}-TUI-LINE-{i}\n")
rpc("term.exec", {"pane": pane, "cmd": f"less {tui_file}"}, window=WIN)
found_tui = False
for _ in range(20):
    time.sleep(0.5)
    if f"{MARK}-TUI-LINE-1" in term_read(WIN, pane):
        found_tui = True; break
if found_tui: ok("alt-screen TUI(less) 진입 + 내용 표시")
else: ng("alt-screen TUI 진입 실패")
snapshot(WIN, "pre-kill")

# ── 3. 봉인 체크포인트 대기 + 디스크 평문 부재 ───────────────────────────────
found_ckpt = False
for _ in range(30):
    if ckpt_files():
        found_ckpt = True; break
    time.sleep(0.5)
if found_ckpt: ok(f"봉인 체크포인트 파일 생성({os.path.basename(ckpt_files()[0])})")
else: ng("체크포인트 파일 미생성(cold restore 의 입력 부재)")
time.sleep(1)
hits = scan_home_for(f"{MARK}-SCROLL-30".encode())
if not hits: ok("identity 홈 디스크에 화면 평문 부재(봉인 확인)")
else: ng(f"화면 평문이 디스크에 노출: {hits}")

# ── 4. 재부팅 모사: 앱 종료(보존) + ptyd SIGKILL ─────────────────────────────
terminate()
kill_daemon()

# ── 5. 재기동 → cold restore 판정 ────────────────────────────────────────────
launch()
labs = rpc("window.list").get("labels", [])
if WIN in labs: ok(f"복원: 창 리스폰({WIN})")
else: ng(f"복원: 창 리스폰 실패(현재 {labs})")
time.sleep(6)  # hydration + 터미널 마운트 + cold 주입 정착
pane2 = pane_of(WIN)
if not pane2:
    ng("복원: 터미널 pane 부재")
else:
    text = term_read(WIN, pane2, lines=400)
    if f"{MARK}-SCROLL-30" in text: ok("cold restore: 스크롤백 마커 재현")
    else: ng("cold restore: 스크롤백 마커 부재")
    if f"{MARK}-TUI-LINE-1" in text: ok("cold restore: alt-screen(TUI) 내용 재현")
    else: ng("cold restore: alt-screen(TUI) 내용 부재")
    # 블록 repaint 의 "[복원됨 …]" 마커와 구분되는, cold 고지 고유 문구를 요구한다.
    if "봉인 체크포인트에서 복원" in text or "sealed checkpoint" in text:
        ok("cold restore: 소실 고지 표시(무음 아님)")
    else: ng("cold restore: 소실 고지 부재(무음)")
    if exec_and_wait(WIN, pane2, f"echo {MARK}-ALIVE", f"{MARK}-ALIVE"):
        ok("복원 후 새 셸 라이브 동작")
    else:
        ng("복원 후 새 셸 무반응")
    # 복원 버퍼의 원문 발췌 — 스냅샷 뷰포트 밖(스크롤백)의 TUI·고지 순서를 로그로 검증.
    lines = [l for l in text.splitlines() if l.strip()]
    idx = [i for i, l in enumerate(lines) if "TUI-LINE-1" in l or "봉인 체크포인트" in l or "sealed checkpoint" in l]
    if idx:
        lo = max(0, min(idx) - 3); hi = min(len(lines), max(idx) + 3)
        print("  복원 버퍼 발췌(뷰포트 밖 스크롤백 포함):")
        for l in lines[lo:hi]:
            print(f"    | {l}")
snapshot(WIN, "post-cold-restore")

# ── 6. 정리(멱등) ────────────────────────────────────────────────────────────
try:
    rpc("window.close", {"label": WIN}); time.sleep(1)
    rpc("project.recent.remove", {"root": PROJ})
    rpc("project.recent.remove", {"root": ROOT})
except Exception:
    pass
terminate()
kill_daemon()
subprocess.run(["rm", "-rf", os.path.join(APP_HOME, "pty")])

print()
print(f"pty-cold-restore: PASS={len(PASS)} FAIL={len(FAIL)}" + (f"  산출물={TMP}" if KEEP or FAIL else ""))
sys.exit(0 if not FAIL else 1)
PYEOF
