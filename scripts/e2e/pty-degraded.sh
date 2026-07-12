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
export PS_PROGRAM="${SOKSAK_TERM_PROGRAM:-terminal-xterm}" PS_APP_HOME="$E2E_APP_HOME"
python3 - <<'PYEOF'
import base64, glob, json, os, re, shutil, socket, subprocess, sys, time, hashlib

SOCK = os.environ["PS_SOCK"]; APP_BIN = os.environ["PS_APP_BIN"]
KEEP = os.environ["PS_KEEP"] == "1"; PTYD_BIN = os.environ["PS_PTYD_BIN"]
PROGRAM = os.environ["PS_PROGRAM"]; APP_HOME = os.environ["PS_APP_HOME"]
E2E_HOME = os.path.join(os.environ["HOME"], ".soksak-e2e")
ROOT = os.path.join(E2E_HOME, "pty-degraded")        # 창 carrier(고정 — 터미널 없음)
RUNS = os.path.join(E2E_HOME, "pty-degraded-runs")   # 런별 대상의 부모
# 대상 프로젝트는 런마다 유일하다(team-lead ①: degraded 전용·불공유 pane id). 고정 루트는 세션·
# command_blocks·봉인이 프로젝트 키로 누적돼 다음 establish 를 오염(warm 재부착·블록 repaint)시킨다.
# 유일 루트면 establish 가 진짜 clean first-open, 재기동 복원은 이 런이 만든 세션에만 warm 후보가 된다.
RUNID = f"{int(time.time() * 1000)}-{os.getpid()}"
PROJ = os.path.join(RUNS, RUNID)
ALIAS = f"pty-degraded-{RUNID}"
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

def app_kill():
    # 앱만 종료(ptyd 는 건드리지 않는다). 셸 세션이 앱 재시작을 넘어 살아남아야 재기동 복원이
    # warm 재부착 후보(paneAlive=true)가 되어 degraded 경로를 탄다 — pty-survival 보존 경로와 동형.
    # 세션 정리는 pkill 이 아니라 문서화된 데몬 제어(reap_all_sessions)가 한다(정공법).
    subprocess.run(["pkill", "-TERM", "-f", APP_PAT])
    for _ in range(60):
        if not app_alive(): break
        time.sleep(0.5)
    if app_alive():
        subprocess.run(["pkill", "-9", "-f", APP_PAT]); time.sleep(1)
    time.sleep(1)

def daemon_sessions():
    try:
        r = rpc("pty.daemon.status"); return int(r.get("sessions") or 0)
    except Exception:
        return -1

def reap_all_sessions():
    # 정공법 reap — 문서화된 pty.daemon.restart(데몬-소유 전 셸 kill 후 신선 데몬 기동). 이전 런/
    # 페이즈가 남긴 생존 세션을 결정적으로 없애 establish 페이즈가 진짜 clean first-open 이 되게 한다.
    # 멱등: 세션 0 이면 killed 0 (no-op). destructive 게이트는 하니스가 배타 점유한 debug 홈이라 무해.
    try:
        r = rpc("pty.daemon.restart"); return int(r.get("killed") or 0)
    except Exception as e:
        print(f"  reap 경고(무시): {e}"); return -1

def degraded_fresh_count():
    # 활동 플러그인이 아직 안 뜬 소켓-업 직후엔 조회가 실패할 수 있다 → 0(이벤트 아직 없음).
    try:
        kinds, _ = activity_kinds()
    except Exception:
        return 0
    return sum(1 for k in kinds if "restore.degraded-fresh" in k)

def ptyd_alive():
    return subprocess.run(["pgrep", "-f", "soksak-debug/bin/soksak-ptyd"], capture_output=True).returncode == 0

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

def launch_socket_only():
    # 소켓만 확인하고 즉시 반환(hydration/복원 페인트 대기 없음) — 복원이 degraded-fresh 를 쏘기
    # '전에' 활동 피드 기준선을 잡기 위해서다.
    env = dict(os.environ)
    if os.path.exists(PTYD_BIN): env["SOKSAK_PTYD_BIN"] = PTYD_BIN
    log = open(os.path.join(TMP, "app.log"), "ab")
    subprocess.Popen([APP_BIN], env=env, stdout=log, stderr=log, start_new_session=True)
    assert wait_socket(), "앱 소켓 기동 실패"

def find_degraded_window():
    for l in rpc("window.list").get("labels", []):
        if not str(l).startswith("w-"): continue
        try:
            tr = rpc("state.tree", window=l, timeout=4)
            if any(str(p.get("alias")) == ALIAS or RUNID in str(p.get("root", "")) for p in tr.get("projects", [])):
                return l
        except Exception: pass
    return None

# ── 0. clean slate: 기동 → 이전 런/페이즈 생존 세션을 문서화된 데몬 제어로 reap ──────────────
# degraded-fresh 는 소비자가 warm 후보(살아있는 세션)를 rehydrate 하려다 사이드카 미가동으로
# 실패할 때만 발행된다(플러그인 orchestrateRestore: paneAlive=true + 사이드카 down + 봉인 없음).
# 따라서 하니스는 pty-survival 처럼 세션을 '먼저 establish' 하고 앱만 재기동해 복원을 태워야 한다.
# 오염(이전 런의 생존 세션에 warm 재부착 → stale 버퍼 재생으로 화면만 위양성)을 없애려면 시작 시
# 전 세션을 reap 해 establish 가 진짜 clean first-open 이 되게 한다.
if app_alive():
    print("  기존 debug 앱 감지 — 종료 후 하니스 소유로 재기동"); app_kill()
# 이전 런의 봉인-블롭/체크포인트 제거 → establish 가 진짜 '봉인 없음' clean first-open 이 된다.
# 사이드카 down 이라 이 하니스는 새 봉인을 안 만들지만, 사이드카가 살아 있던 과거 런(예: cold-realistic)
# 의 잔재 blob 이 establish 에서 cold 복원을 유발해 오염시킨다 — cold-realistic 과 동형으로 <home>/pty 를 걷는다.
subprocess.run(["rm", "-rf", os.path.join(APP_HOME, "pty")])
launch()
killed = reap_all_sessions(); time.sleep(3)  # 문서화된 데몬 제어로 전 세션 reap + 재기동 안정화
for l in list(rpc("window.list").get("labels", [])):
    if str(l).startswith("w-"):
        try:
            tr = rpc("state.tree", window=l, timeout=4)
            if any("pty-degraded" in str(p.get("root", "")) for p in tr.get("projects", [])):
                rpc("window.close", {"label": l}); time.sleep(0.5)
        except Exception: pass
# 이전 런의 유일-루트 잔재 정리(멱등) — recent 목록에서 제거 + 디렉토리 삭제(현재 런 제외).
for old in glob.glob(os.path.join(RUNS, "*")):
    if os.path.abspath(old) == os.path.abspath(PROJ): continue
    try: rpc("project.recent.remove", {"root": old})
    except Exception: pass
    shutil.rmtree(old, ignore_errors=True)
print(f"  clean slate: reap killed={killed}, 잔여 세션={daemon_sessions()}, blob store 제거, 유일 루트={RUNID}")

NOTICE = "복원 서비스 미가동"

# ── 1. establish: degraded 전용 pane 에 세션 생성. clean slate 라 paneAlive=false → 조용한 fresh
#      스폰(고지 없음). 이 세션이 앱 재시작을 넘어 살아남아야 복원이 warm 후보가 된다. ──────────
r = rpc("window.open", {"root": ROOT}); time.sleep(4)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"establish: 창 생성 실패: {r}"
created = rpc("project.open", {"root": PROJ, "alias": ALIAS, "program": PROGRAM}, window=WIN)
assert created.get("ok"), f"establish: project.open 실패: {created}"
time.sleep(3)
pane = None
for _ in range(24):
    time.sleep(0.5)
    pane = pane_of(WIN)
    if pane: break
assert pane, "establish: 터미널 pane 을 찾지 못함"
m0 = exec_and_read(WIN, pane, "echo PDEGR_EST=$$", r"PDEGR_EST=(\d+)", secs=12)
assert m0, "establish: 셸이 명령에 응답 안 함(세션 미생성)"
est_pid = m0.group(1)
est_txt = term_read(WIN, pane, lines=60)
if NOTICE not in est_txt: ok("establish: clean first-open 은 무음(degraded 고지 없음)")
else: ng(f"establish 오염: clean 이어야 할 first-open 에 이미 degraded 고지 — reap 실패? {est_txt[:120]!r}")
print(f"  establish: 창={WIN} pane={pane} 셸 pid={est_pid} 세션수={daemon_sessions()}")
time.sleep(3)  # 자동저장 디바운스 정착 — establish 창/프로젝트가 세션에 저장돼야 재기동이 복원한다.

# ── 2. 앱 종료(ptyd 보존) — 세션이 detach 생존해야 복원이 warm 후보가 된다 ──────────────────
# 앱이 죽으면 앱 소켓으로 세션수 조회 불가 → 생존 증거는 phase 5 의 재부착 pid 동일성이다.
app_kill()
if ptyd_alive(): ok("앱 종료 후 ptyd 데몬 생존(세션 detach 유지)")
else: ng("앱 종료 후 ptyd 데몬 부재 — 세션 detach 실패로 degraded 전제 미성립")

# ── 3. RED 판정선: 재기동 복원(사이드카 미가동) → orchestrateRestore warm+down → degraded-fresh.
#      before_df 를 복원 발행 '전' 신선 피드에서 잡아, 이번 복원이 새로 쏜 이벤트만 인정한다 —
#      생존 세션 stale 버퍼 재생은 활동 이벤트를 재발행하지 않으므로 화면 위양성을 이 단언이 막는다. ──
launch_socket_only()
before_df = degraded_fresh_count()
time.sleep(6)  # hydration + 터미널 마운트 + rehydrate 데드라인(4s) 경과
RWIN = WIN if WIN in rpc("window.list").get("labels", []) else find_degraded_window()
assert RWIN, "복원: degraded 창을 못 찾음"
pane = None
for _ in range(28):  # ~14s 상한
    time.sleep(0.5)
    pane = pane_of(RWIN)
    if pane and NOTICE in term_read(RWIN, pane, lines=60): break
assert pane, "복원: 터미널 pane 을 찾지 못함"
print(f"  복원: 창={RWIN} pane={pane} program={PROGRAM} before_df={before_df}")

# ── 4. degraded-fresh 판정 ───────────────────────────────────────────────────
text = term_read(RWIN, pane, lines=60)
if NOTICE in text: ok("degraded: 화면에 loud 고지(무음 아님)")
else: ng(f"degraded: 화면 고지 부재 — 버퍼 발췌 {text[:120]!r}")

# 활동 로그 고지 — 이번 복원이 '새로' 쏜 degraded-fresh 여야 한다(전파 지연 흡수 유계 폴링).
after_df = before_df
for _ in range(16):
    after_df = degraded_fresh_count()
    if after_df > before_df: break
    time.sleep(0.5)
kinds, blob = activity_kinds()
if after_df > before_df:
    ok(f"degraded: 활동 로그 고지(terminal.restore.degraded-fresh, 이번 복원 신규 {before_df}->{after_df})")
else:
    ng(f"degraded: degraded-fresh 활동 이벤트 미발행(before={before_df} after={after_df}) — 복원 경로 미실행/stale 재생 의심. kinds {sorted(set(kinds))[:12]}")
if any("sidecar" in k and "spawn-failed" in k for k in kinds): ok("degraded: 사이드카 스폰 실패도 고지")
else: ng("degraded: 사이드카 스폰 실패 미고지")

# 코어 폴백 방출 확인: TypeError/undefined 크래시·boot.error 가 없어야 한다(무너지지 않고 degraded).
if any("boot.error" in k for k in kinds): ng(f"degraded: boot.error 발생 — {blob[:200]}")
else: ok("degraded: boot.error 없음")
if ("TypeError" in blob) or ("is not a function" in blob) or ("Cannot read" in blob):
    ng(f"degraded: 런타임 크래시 흔적 — {blob[:200]}")
else: ok("degraded: TypeError/undefined 크래시 없음")

# ── 5. 셸이 실제로 산다(복원이 degraded 라도 라이브 셸은 동작) — degraded-fresh 활동 이벤트가
#      이미 warm 후보(paneAlive=true) 였음을 증명하므로 pid 동일성은 강제하지 않는다(고지 문구대로
#      새 셸로 갈 수 있다). ────────────────────────────────────────────────────────────────
m = exec_and_read(RWIN, pane, "echo PDEGR_LIVE=$$", r"PDEGR_LIVE=(\d+)")
if m: ok(f"degraded: 셸 라이브 동작(pid {m.group(1)}, establish {est_pid})")
else: ng("degraded: 셸이 명령에 응답 안 함")

snapshot(RWIN, "degraded-fresh")

# ── 6. 정리(멱등) — 창 닫기(KillByWindow reap) + 전 세션 reap + 앱 종료 ──────────────────────
if not KEEP:
    try: rpc("window.close", {"label": RWIN})
    except Exception: pass
    time.sleep(0.5)
    reap_all_sessions()
    try:
        rpc("project.recent.remove", {"root": PROJ}); rpc("project.recent.remove", {"root": ROOT})
    except Exception: pass
    app_kill()
    subprocess.run(["rm", "-rf", os.path.join(APP_HOME, "pty")])  # 봉인-블롭 누수 방지(멱등)

n = len(PASS); f = len(FAIL)
print(f"pty-degraded: PASS={n} FAIL={f}  산출물={TMP}")
sys.exit(1 if f else 0)
PYEOF
rc=$?
# trap 이 사이드카를 복원한다. 명시 로그로 원복 확인.
restore_sidecar
echo "  사이드카 복원: $([ -f "$SIDECAR_BIN" ] && echo PRESENT || echo MISSING)"
exit $rc
