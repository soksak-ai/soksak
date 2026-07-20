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
# 격리 모델(테스트 표준): 실 identity 홈(설치본 플러그인+사이드카를 그대로 쓴다 — dev.load·홈 격리 없이)
# 에서 돌되, DB·볼트는 런 전용 disposable temp(RUNDIR)로 격리한다: SOKSAK_DATA_DIR(DB)+SOKSAK_VAULT_PATH
# (볼트). 매 런 fresh 라 실 DB 의 잔재 키에 R23(키 등록됨+볼트 부재=새 볼트 거부)로 막히지 않고, 끝나면
# RUNDIR 통째 삭제 → 하니스가 스스로도 실홈도 오염 안 시킨다(파괴적 실-DB 리셋 불필요). 볼트 unlock 은
# debug 전용 결정적 SOKSAK_E2E_KEK(SHA-256, release 엔 부재 — P0 이 프로덕션 env 언락 SOKSAK_VAULT_KEY
# 를 제거). 봉인 키 캐시(seal.pub)·봉인-블롭을 담은 <home>/pty 는 실홈에 있으니(설치본 사이드카가 거기
# 체크포인트한다) 시작·종료 시 정리한다(런 볼트와 재짝지음 — 멱등).
#
# 사용: bash scripts/e2e/pty-cold-restore.sh [--identity debug]   (KEEP=1: 캡처·RUNDIR 보존)
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
ROOT = os.path.join(E2E_HOME, "pty-cold")         # 창 carrier(고정)
# 이 하니스는 cold 주입 "메커니즘"을 격리 검증한다: 데몬 사망 후 봉인 체크포인트가
# 화면(스크롤백·TUI·고지)을 버퍼에 복원하는가. 런마다 새 프로젝트(빈 이력)를 써
# blocks-repaint 이력 누적이 오라클을 흐리지 않게 한다 — 실사용(이력 있는 재오픈)의
# "뷰포트 안" 검증은 별도 하니스 pty-cold-realistic.sh 가 맡는다. 창 carrier(ROOT)는 고정.
GEN = f"{os.getpid()}-{int(time.time())}"
PROJ = os.path.join(E2E_HOME, f"pty-cold-proj-{GEN}")  # 이 런 전용 프로젝트(빈 이력)
ALIAS = f"pty-cold-e2e-{GEN}"
# 터미널 엔진 유닛(봉인 복원 소비자). 기본 xterm — SOKSAK_TERM_PROGRAM 로 ghostty 를
# 겨눌 수 있다(M3 는 두 엔진을 같은 사이드카에 배선; pane_of 는 엔진 무관).
PROGRAM = os.environ.get("SOKSAK_TERM_PROGRAM", "terminal-xterm")
MARK = f"PCOLD{os.getpid()}"
TMP = os.path.join(E2E_HOME, "pty-cold-artifacts")   # 산출물(캡처·로그) — 보존
# 런 전용 DB+볼트(disposable). SOKSAK_DATA_DIR 로 실홈 DB(잔재 키) 를 우회하고, 끝나면 통째 삭제한다 —
# 테스트가 실 데이터를 안 건드리고 자기 상태만 자기정리한다(홈의 설치본 플러그인·사이드카는 그대로 쓴다).
RUNDIR = os.path.join(E2E_HOME, f"pty-cold-rundb-{GEN}")
DATA_DIR = os.path.join(RUNDIR, "data")
VAULT = os.path.join(RUNDIR, "vault.json")
for d in (ROOT, PROJ, TMP, DATA_DIR):
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
    env["SOKSAK_DATA_DIR"] = DATA_DIR      # 런 전용 DB(실홈 DB·잔재키 비오염 — fresh 라 R23 없음)
    env["SOKSAK_VAULT_PATH"] = VAULT       # 런 전용 볼트(실볼트 비오염)
    env["SOKSAK_E2E_KEK"] = "pty-cold-e2e-pass"  # debug 전용 결정적 KEK(키체인 불요·CI·release 엔 부재)
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
    # 재부팅 모사 — 이 identity 홈의 ptyd 만 SIGKILL(정상 종료 경로 없음 → 체크포인트 잔존).
    # 홈/바이너리로 스코프한다: 전역 pkill 은 병행 실행 중인 다른 identity(사용자 dev 앱)의
    # ptyd 까지 죽여 그쪽 살아있는 터미널을 파괴한다(불가침 위반). ptyd 는 <home>/bin 에
    # 복사돼 뜨거나(관측된 형태) 빌드 경로에서 직접 뜬다 — 둘 다 겨눈다.
    out = subprocess.run(["pgrep", "-fl", "soksak-ptyd"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        pid, _, cmd = line.partition(" ")
        if APP_HOME in cmd or PTYD_BIN in cmd:
            try: os.kill(int(pid), signal.SIGKILL)
            except Exception: pass
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
        if last is not None and h != last:
            break
        last = h
    p = os.path.join(TMP, f"{name}.png"); open(p, "wb").write(png)
    print(f"  캡처: {p}")

# 이 pane 의 체크포인트 파일 — soksak-spec-pty 의 base64url(무패딩) 파생과 동형.
# glob 로 아무 파일이나(형제 창의 것) 집으면 오라클을 흐린다: 반드시 (창,pane) 로 특정한다.
# 체크포인트는 홈 파생(<home>/pty) — DB(RUNDIR)와 별개다(설치본 사이드카가 실홈에 봉인한다).
def ckpt_path_for(window, pane):
    comp = lambda s: base64.urlsafe_b64encode(s.encode()).rstrip(b"=").decode()
    return os.path.join(APP_HOME, "pty", "checkpoints", f"ckpt-{comp(window)}.{comp(pane)}.json")

def scan_dirs_for(needle: bytes):
    # 봉인 확인: command_blocks 는 런 DB(RUNDIR)에, 봉인 체크포인트는 실홈 <home>/pty 에 있어야 한다 —
    # 둘 다 스캔해 화면 평문이 어느 쪽에도 안 남았음을 본다.
    hits = []
    for root in (RUNDIR, APP_HOME):
        for base, _dirs, files in os.walk(root):
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

# 워크스페이스 격리: 부팅이 복원한 모든 창을 닫는다. debug 홈은 여러 테스트의 창이
# 누적되는 공용 identity 라, 형제 창들이 매 부팅 터미널을 재봉인해 오라클을 흐리고
# (체크포인트 디렉토리에 남의 파일이 섞임) 재기동 복원을 군집으로 만든다. 이 런은
# 자기 창 하나만 열고, terminate 후 재기동도 그 하나만 복원하게 한다(단일창 결정성).
def close_all_windows():
    for l in rpc("window.list").get("labels", []):
        if not str(l).startswith("w-"):
            continue
        try:
            rpc("window.close", {"label": l})
        except Exception:
            pass
        time.sleep(0.3)
close_all_windows()

# 이전 세대 프로젝트·런DB 정리(멱등) — 크래시로 정리 못 하고 남은 지난 런 잔재를 걷는다(post-launch:
# project.recent.remove 는 rpc 를 쓰니 앱 기동 후). 이 런 전용(PROJ·RUNDIR)은 건너뛴다.
for old in glob.glob(os.path.join(E2E_HOME, "pty-cold-proj-*")) + glob.glob(os.path.join(E2E_HOME, "pty-cold-rundb-*")):
    if old in (PROJ, RUNDIR):
        continue
    try:
        rpc("project.recent.remove", {"root": old})
    except Exception:
        pass
    subprocess.run(["rm", "-rf", old])

# ── 1. 창 + 터미널 ───────────────────────────────────────────────────────────
r = rpc("window.open", {"root": ROOT}); time.sleep(4)
WIN = r.get("label") or r.get("existingWindow")
assert WIN, f"창 생성 실패: {r}"
# 터미널 엔진 플러그인은 홈에 설치만 되고 disabled 일 수 있다(설치≠활성). program 을 여는 전제로
# 동의+활성을 멱등 보장한다 — 다른 e2e(webview-crash) 도 픽스처를 이렇게 세운다. 실홈에 설치된
# 플러그인·사이드카를 그대로 쓴다(dev.load 아님 — debug 빌드엔 dev.load 배선을 두지 않는다).
TERM_PLUGIN = f"soksak-plugin-{PROGRAM}"
st = next((p for p in rpc("plugin.list", window=WIN).get("plugins", []) if p.get("id") == TERM_PLUGIN), None)
if not st:
    ng(f"터미널 플러그인 미설치({TERM_PLUGIN}) — dev 유닛을 발행/설치한 debug 홈에서 실행해야 한다")
if not st or st.get("status") != "enabled":
    rpc("plugin.consent.grant", {"id": TERM_PLUGIN}, window=WIN)
    en = rpc("plugin.enable", {"id": TERM_PLUGIN}, window=WIN)
    if en.get("ok") is False:
        ng(f"터미널 플러그인 활성 실패({TERM_PLUGIN}): {en.get('message') or en.get('code')}")
    time.sleep(2)
created = rpc("project.open", {"root": PROJ, "alias": ALIAS, "program": PROGRAM}, window=WIN)
assert created.get("ok"), f"project.open 실패: {created}"
time.sleep(3)
pane = pane_of(WIN)
assert pane, "터미널 pane 을 찾지 못함"
print(f"  창={WIN} pane={pane}")

# 이 프로젝트 scope 의 app.data 암호화 활성 — command_blocks(의미 축)도 봉인되어야
# "잠금 상태 디스크 평문 부재"가 DB·홈 스캔으로 성립한다(P1 게이트 문구). 런 DB 는 fresh 라
# 항상 새로 활성된다(누적 없음 — 끝에 RUNDIR 삭제).
enc = rpc("data.encrypt.enable", {"scope": PROJ}, window=WIN)
if enc.get("ok") is False and "이미 암호화" in str(enc.get("message", "")):
    print("  data.encrypt.enable: 이미 활성 — 멱등 통과")
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
# 이 pane 의 체크포인트만 본다 — 형제 창의 파일(glob[0])이 아니라 (WIN,pane) 파생.
OUR_CKPT = ckpt_path_for(WIN, pane)
found_ckpt = False
for _ in range(30):
    if os.path.exists(OUR_CKPT):
        found_ckpt = True; break
    time.sleep(0.5)
if found_ckpt: ok(f"봉인 체크포인트 파일 생성({os.path.basename(OUR_CKPT)})")
else: ng("체크포인트 파일 미생성(cold restore 의 입력 부재)")
time.sleep(1)
hits = scan_dirs_for(f"{MARK}-SCROLL-30".encode())
if not hits: ok("런 DB·identity 홈 디스크에 화면 평문 부재(봉인 확인)")
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
subprocess.run(["rm", "-rf", PROJ])  # 이 런 전용 프로젝트 회수(세대 격리 — 빈 이력 유지)
if not KEEP:
    subprocess.run(["rm", "-rf", RUNDIR])  # 런 전용 DB+볼트 통째 삭제(자기정리 격리)

print()
print(f"pty-cold-restore: PASS={len(PASS)} FAIL={len(FAIL)}" + (f"  산출물={TMP}" if KEEP or FAIL else ""))
sys.exit(0 if not FAIL else 1)
PYEOF
