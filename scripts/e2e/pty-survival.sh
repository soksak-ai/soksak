#!/bin/bash
# PTY 생존 E2E (W5 M0) — 셸과 그 자식 프로세스가 앱 재시작을 넘어 같은 pid 로
# 생존하는지를 판정한다. 시나리오(플랜 §5.5 M0):
#   터미널 pane 스폰 → `sleep 9999 &` + 셸 pid 기록 → 앱 종료(보존 경로) →
#   재기동 복원 → 같은 pane 의 셸 pid 동일 + sleep 생존 + 스크롤백 마커 재현 단언.
#
# 이 하니스는 soksak-ptyd(PTY 데몬 분리) 이전에는 반드시 RED 다 — 앱 종료가
# PTY master 를 닫아 셸이 SIGHUP 으로 죽는다(pty.rs kill_all / master drop).
# warm reattach 랜딩 후 GREEN 이 이 하니스의 완료 판정이다.
#
# 멱등: 전용 임시 root(~/.soksak-e2e/pty-survival*) 창 1개 안에서만 동작 — 사용자
# 워크스페이스 무접촉. debug identity 홈(~/.soksak-debug)을 쓴다(browser-restore 선례).
# 앱은 이 하니스가 직접 기동한다(env 주입 필요: 바이너리 직접 exec — `open` 은 env 미전달).
# 종료 시 sleep 회수 + 창 닫기(스냅샷 prune, B1) + 앱 종료.
#
# 사용: bash scripts/e2e/pty-survival.sh [--identity debug]   (KEEP=1: 캡처 보존)
set -uo pipefail

IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# 빌드 산출 디렉토리는 cargo 가 진실이다(.cargo/config.toml 의 target-dir 재지정을 따라간다 —
# 워크트리 공유 target 에서도 같은 경로가 나온다). 경로 추측 금지.
TARGET_DIR="$(cd "$ROOT_DIR/src-tauri" && cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['target_directory'])")"
APP_BUNDLE="$TARGET_DIR/debug/bundle/macos/soksak-$IDENTITY.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/soksak-$IDENTITY"
# identity 홈 계약(docs/ARCHITECTURE.md — home.rs·sok CLI 와 동일): app=~/.soksak, 그 외 -<identity>.
if [ "$IDENTITY" = "app" ]; then E2E_APP_HOME="$HOME/.soksak"; else E2E_APP_HOME="$HOME/.soksak-$IDENTITY"; fi
SOCK="$E2E_APP_HOME/com.soksak.$IDENTITY.sock"
# ptyd 소스 바이너리(홈 bin/ 스테이징의 원본) — 워크스페이스 빌드 산출물. 없으면 미주입(앱은
# 로컬 폴백으로 뜬다 — 데몬 이전에는 존재하지 않으므로 RED 실행에서도 안전).
PTYD_BIN="$TARGET_DIR/debug/soksak-ptyd"

[ -x "$APP_BIN" ] || { echo "RED: 앱 번들 없음(make build-debug 먼저): $APP_BIN" >&2; exit 1; }

export PS_SOCK="$SOCK" PS_APP_BIN="$APP_BIN" PS_KEEP="${KEEP:-0}" PS_PTYD_BIN="$PTYD_BIN"
python3 - <<'PYEOF'
import base64, json, os, signal, socket, subprocess, sys, time

SOCK = os.environ["PS_SOCK"]; APP_BIN = os.environ["PS_APP_BIN"]
KEEP = os.environ["PS_KEEP"] == "1"; PTYD_BIN = os.environ["PS_PTYD_BIN"]
E2E_HOME = os.path.join(os.environ["HOME"], ".soksak-e2e")
ROOT = os.path.join(E2E_HOME, "pty-survival")        # 창 carrier(window.open 부트 프로젝트)
PROJ = os.path.join(E2E_HOME, "pty-survival-proj")   # 실제 대상(터미널 1개)
ALIAS = "pty-survival-e2e"
# 터미널 엔진 유닛(생존 사이드카 소비자). 기본 xterm — M3 는 두 엔진을 같은 사이드카에
# 배선하므로 SOKSAK_TERM_PROGRAM 로 ghostty 를 겨눌 수 있다(pane_of 는 엔진 무관).
PROGRAM = os.environ.get("SOKSAK_TERM_PROGRAM", "terminal-xterm")
MARK = f"PSURV{os.getpid()}"
TMP = os.path.join(E2E_HOME, "pty-survival-artifacts")
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

APP_PAT = "soksak-debug.app/Contents/MacOS"
def app_alive():
    return subprocess.run(["pgrep", "-f", APP_PAT], capture_output=True).returncode == 0

def launch():
    # 바이너리 직접 exec — SOKSAK_PTYD_BIN(홈 bin/ 스테이징 원본)을 앱 env 로 주입한다.
    # `open` 은 LaunchServices 경유라 env 를 전달하지 못한다.
    env = dict(os.environ)
    if os.path.exists(PTYD_BIN): env["SOKSAK_PTYD_BIN"] = PTYD_BIN
    log = open(os.path.join(TMP, "app.log"), "ab")
    subprocess.Popen([APP_BIN], env=env, stdout=log, stderr=log,
                     start_new_session=True)
    assert wait_socket(), "앱 소켓 기동 실패"
    time.sleep(4)  # 프론트 부트 정착

def terminate():
    # 보존 경로(개별 창 닫기가 아님 — 스냅샷·manifest 유지). browser-restore 선례.
    subprocess.run(["pkill", "-TERM", "-f", APP_PAT])
    for _ in range(60):
        if not app_alive(): break
        time.sleep(0.5)
    if app_alive():
        subprocess.run(["pkill", "-9", "-f", APP_PAT]); time.sleep(1)
    time.sleep(1)

def pid_alive(pid):
    try:
        os.kill(int(pid), 0); return True
    except Exception:
        return False

def pane_of(win):
    # 터미널 뷰 = plugin 뷰(soksak-plugin-terminal-xterm). pane id 는 focusedPaneId(분할 시) 또는
    # 뷰 id — e2e-driver.mjs panesOf 와 같은 규칙.
    tr = rpc("state.tree", window=win)
    for p in tr.get("projects", []):
        if p.get("alias") == ALIAS or p.get("title") == ALIAS:
            content = next((c for c in p["spaces"] if c.get("active")), p["spaces"][0])
            for g in content.get("panels", []):
                for v in g.get("views", []):
                    if "terminal" in str(v.get("plugin", "")) or v.get("kind") == "terminal":
                        return v.get("focusedPaneId") or v.get("id")
    return None

def term_read(win, pane, lines=40):
    r = rpc("term.read", {"pane": pane, "lines": lines}, window=win)
    return r.get("text") or ""

def exec_and_read(win, pane, cmd, pattern, secs=8):
    rpc("term.exec", {"pane": pane, "cmd": cmd}, window=win)
    import re
    for _ in range(secs * 2):
        time.sleep(0.5)
        m = re.search(pattern, term_read(win, pane))
        if m: return m
    return None

def snapshot(win, name):
    # 시각 검증(R3)은 대상 창이 '보여야' 유효하다 — 가려진 창은 OS 가 rAF 를 멈춰(WKWebView)
    # 터미널/오버레이가 안 그려지고 스냅샷이 정지 프레임(백지)이 된다. 캡처 직전 창을 전면화해
    # rAF 를 재개시킨 뒤 렌더 프레임이 나오길 md5 변화(사쿠라 애니메이션)로 확인하고 담는다.
    # 전면화는 '의도된 명령'(스폰테이너스 아님) — 시각 검증 계약의 일부.
    import hashlib
    try:
        rpc("window.focus", {"label": win})
    except Exception:
        pass
    last = None
    for _ in range(12):  # rAF 재개 대기(유계 — 12프레임 상당). 렌더 프레임 나오면 즉시 진행.
        time.sleep(0.25)
        try:
            r = rpc("window.snapshot", {"base64": True}, window=win)
            png = base64.b64decode(r["media"]["base64"])
        except Exception as e:
            print(f"  캡처 실패({name}): {e}"); return
        h = hashlib.md5(png).hexdigest()
        if last is not None and h != last:  # 프레임이 갱신됨 = rAF 동작 = 유효
            break
        last = h
    p = os.path.join(TMP, f"{name}.png"); open(p, "wb").write(png)
    print(f"  캡처: {p}")

# ── 0. 준비: 앱 기동(이 하니스 소유 인스턴스) + 잔재 창 정리 ─────────────────
if app_alive():
    print("  기존 debug 앱 인스턴스 감지 — 종료 후 하니스 소유로 재기동")
    terminate()
launch()

def leftover_windows():
    labs = rpc("window.list").get("labels", [])
    res = []
    for l in labs:
        if not str(l).startswith("w-"): continue
        try:
            tr = rpc("state.tree", window=l, timeout=4)
            if any("pty-survival" in str(p.get("root", "")) for p in tr.get("projects", [])):
                res.append(l)
        except Exception:
            pass
    return res
for l in leftover_windows():
    rpc("window.close", {"label": l}); time.sleep(0.5)

# ── 1. 창 + 터미널 프로젝트 ──────────────────────────────────────────────────
r = rpc("window.open", {"root": ROOT}); time.sleep(4)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"창 생성 실패: {r}"
created = rpc("project.open", {"root": PROJ, "alias": ALIAS, "program": PROGRAM}, window=WIN)
assert created.get("ok"), f"project.open 실패: {created}"
time.sleep(3)
pane = pane_of(WIN)
assert pane, "터미널 pane 을 찾지 못함"
print(f"  창={WIN} pane={pane}")

# ── 2. 셸 pid + 장수 자식 기록 ───────────────────────────────────────────────
m = exec_and_read(WIN, pane, f"echo {MARK}_SHELL=$$", MARK + r"_SHELL=(\d+)")
assert m, "셸 pid 마커 미검출"
shell_pid = m.group(1)
m = exec_and_read(WIN, pane, f"sleep 9999 & echo {MARK}_SLEEP=$!", MARK + r"_SLEEP=(\d+)")
assert m, "sleep pid 마커 미검출"
sleep_pid = m.group(1)
print(f"  shell pid={shell_pid} sleep pid={sleep_pid}")
assert pid_alive(shell_pid) and pid_alive(sleep_pid), "기록 직후 프로세스 부재(측정 무효)"
snapshot(WIN, "pre-exit")
time.sleep(2)  # 자동저장 디바운스 정착

# ── 3. 앱 종료(보존 경로) — 생존 판정의 본체 ────────────────────────────────
terminate()
if pid_alive(shell_pid): ok(f"앱 종료 후 셸 생존(pid {shell_pid})")
else: ng(f"앱 종료가 셸을 죽임(pid {shell_pid})")
if pid_alive(sleep_pid): ok(f"앱 종료 후 sleep 생존(pid {sleep_pid})")
else: ng(f"앱 종료가 sleep 을 죽임(pid {sleep_pid})")

# ── 4. 재기동 → 같은 pane 재부착 판정 ────────────────────────────────────────
launch()
labs = rpc("window.list").get("labels", [])
if WIN in labs: ok(f"복원: 창 리스폰({WIN})")
else: ng(f"복원: 창 리스폰 실패(현재 {labs})")
time.sleep(5)  # hydration + 터미널 마운트 정착
pane2 = pane_of(WIN)
print(f"  복원 pane={pane2} (원본 {pane})")
if pane2:
    # 스크롤백 텍스트 재현 — 주의: 블록 repaint(터미널 복원)도 이 문자열을 되살리므로
    # 이것만으로는 warm reattach 증거가 아니다. 재부착 증거는 아래 pid 동일성이다.
    text = term_read(WIN, pane2, lines=120)
    if f"{MARK}_SHELL={shell_pid}" in text:
        ok("복원: 종료 전 스크롤백 텍스트 재현(repaint 또는 reattach)")
    else:
        ng("복원: 종료 전 스크롤백 텍스트 부재")
    m = exec_and_read(WIN, pane2, f"echo {MARK}_SHELL2=$$", MARK + r"_SHELL2=(\d+)")
    shell_pid2 = m.group(1) if m else None
    if shell_pid2 == shell_pid: ok(f"복원: 같은 pane 셸 pid 동일({shell_pid})")
    else: ng(f"복원: 셸 pid 불일치(전 {shell_pid} → 후 {shell_pid2})")
else:
    ng("복원: 터미널 pane 부재")
if pid_alive(sleep_pid): ok(f"복원 후 sleep 계속 생존(pid {sleep_pid})")
else: ng(f"복원 후 sleep 사망(pid {sleep_pid})")
snapshot(WIN, "post-restore")

# ── 5. 정리(멱등) ────────────────────────────────────────────────────────────
if pid_alive(sleep_pid):
    try: os.kill(int(sleep_pid), signal.SIGTERM)
    except Exception: pass
try:
    rpc("window.close", {"label": WIN}); time.sleep(1)
    rpc("project.recent.remove", {"root": PROJ})
    rpc("project.recent.remove", {"root": ROOT})
except Exception:
    pass
terminate()

print()
print(f"pty-survival: PASS={len(PASS)} FAIL={len(FAIL)}" + (f"  산출물={TMP}" if KEEP or FAIL else ""))
sys.exit(0 if not FAIL else 1)
PYEOF
