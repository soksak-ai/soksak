#!/bin/bash
# 브라우저 복원 E2E — 멱등·반복 가능(내재화). 시나리오(사용자 확정):
#   여러 브라우저를 양 엔진 혼합(WKWebView `browser` + Chromium `browser-chromium`)으로
#   멀티 창에 켜고 → 창을 오가고 → 앱을 종료(SIGTERM=보존 경로)하고 → 재기동 복원 후
#   복원된 창을 오가며 각 브라우저가 "실제로 렌더링되는지"를 픽셀로 판정한다.
#
# 판정: 창 스냅샷(window.snapshot base64)의 콘텐츠 영역 평균 밝기. example.* 페이지는
# 밝은(≈230) 배경이고 앱 테마는 어두워(≈40), 임계 150 이 렌더/블랭크를 가른다 —
# "탭 제목이 복원됐다"가 아니라 "페이지가 화면에 그려졌다"를 단언한다.
#
# 멱등: 전용 임시 root(/tmp/soksak-e2e-brestore-{a,b}) 창 2개 안에서만 동작 — 사용자
# 워크스페이스 무접촉. 종료 시 생성 창·뷰를 닫고(스냅샷 prune, B1) 임시 root 를 지운다.
# 앱은 실행 중이면 그대로 쓰고(중간에 재시작함), 없으면 번들을 띄운다.
#
# 사용: bash scripts/e2e/browser-restore.sh [--identity debug]   (KEEP=1: 캡처 보존)
set -uo pipefail

IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT_DIR/src-tauri/target/debug/bundle/macos/soksak-$IDENTITY.app"
# identity 홈 계약(docs/ARCHITECTURE.md — home.rs·sok CLI 와 동일): app=~/.soksak, 그 외 -<identity>.
if [ "$IDENTITY" = "app" ]; then SOKSAK_E2E_HOME="$HOME/.soksak"; else SOKSAK_E2E_HOME="$HOME/.soksak-$IDENTITY"; fi
SOCK="$SOKSAK_E2E_HOME/com.soksak.$IDENTITY.sock"
KEEP="${KEEP:-0}"

# identity 홈 계약(docs/ARCHITECTURE.md — home.rs·sok CLI 와 동일): app=~/.soksak, 그 외 -<identity>.
if [ "$IDENTITY" = "app" ]; then SOKSAK_E2E_HOME="$HOME/.soksak"; else SOKSAK_E2E_HOME="$HOME/.soksak-$IDENTITY"; fi

export BR_SOCK="$SOCK" BR_APP="$APP" BR_KEEP="$KEEP"
python3 - <<'PYEOF'
import base64, json, os, socket, struct, subprocess, sys, tempfile, time, zlib

SOCK = os.environ["BR_SOCK"]; APP = os.environ["BR_APP"]; KEEP = os.environ["BR_KEEP"] == "1"
TMP = tempfile.mkdtemp(prefix="brestore-")
PASS = []; FAIL = []
def ok(m): PASS.append(m); print(f"  ✓ {m}")
def ng(m): FAIL.append(m); print(f"  ✗ {m}")

def rpc(method, params=None, window="main", timeout=25):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout); s.connect(SOCK)
    req = {"id": 1, "method": method, "params": params or {}, "window": window}
    s.sendall((json.dumps(req) + "\n").encode())
    buf = b""
    while b"\n" not in buf: buf += s.recv(1 << 20)
    s.close()
    resp = json.loads(buf.split(b"\n")[0])
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return {**resp["data"], **{k: v for k, v in resp.items() if k != "data"}}
    return resp

def wait_socket(secs=40):
    for _ in range(secs * 2):
        try:
            rpc("window.list", timeout=5); return True
        except Exception: time.sleep(0.5)
    return False

def app_alive():
    return subprocess.run(["pgrep", "-f", "soksak-debug.app/Contents/MacOS"],
                          capture_output=True).returncode == 0

def launch():
    for _ in range(3):
        r = subprocess.run(["open", APP], capture_output=True)
        if r.returncode == 0: break
        time.sleep(3)  # LaunchServices -600(이전 인스턴스 정리 중) 재시도
    assert wait_socket(), "앱 소켓 기동 실패"
    time.sleep(4)  # 프론트 부트 정착

def terminate():
    subprocess.run(["pkill", "-TERM", "-f", "soksak-debug.app/Contents/MacOS"])
    for _ in range(60):
        if not app_alive(): break
        time.sleep(0.5)
    if app_alive():
        subprocess.run(["pkill", "-9", "-f", "soksak-debug.app/Contents/MacOS"]); time.sleep(1)
    time.sleep(1)

# ── PNG 평균 밝기(순수 파이썬, RGBA8/RGB8 non-interlaced — ScreenCaptureKit 산출 커버) ──
def png_brightness(data, box):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos = 8; idat = b""; w = h = ct = bd = None
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos+8]); pos += 8
        chunk = data[pos:pos+ln]; pos += ln + 4
        if typ == b"IHDR": w, h, bd, ct = struct.unpack(">IIBB", chunk[:10])
        elif typ == b"IDAT": idat += chunk
        elif typ == b"IEND": break
    assert bd == 8 and ct in (2, 6), f"unsupported png ct={ct} bd={bd}"
    ch = 4 if ct == 6 else 3
    raw = zlib.decompress(idat); stride = w * ch
    out = bytearray(); prev = bytearray(stride); i = 0
    for _ in range(h):
        f = raw[i]; i += 1; line = bytearray(raw[i:i+stride]); i += stride
        if f == 1:
            for x in range(ch, stride): line[x] = (line[x] + line[x-ch]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride): line[x] = (line[x] + ((line[x-ch] if x >= ch else 0) + prev[x]) // 2) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-ch] if x >= ch else 0; b = prev[x]; c = prev[x-ch] if x >= ch else 0
                p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line; prev = line
    x0, y0, x1, y1 = (int(w*box[0]), int(h*box[1]), int(w*box[2]), int(h*box[3]))
    s = n = 0
    for y in range(y0, y1, 4):
        row = y * stride
        for x in range(x0, x1, 4):
            o = row + x * ch; s += out[o] + out[o+1] + out[o+2]; n += 3
    return s / max(n, 1)

# 콘텐츠 본문 영역(사이드바·탭바 제외한 우하 영역) — 밝은 페이지면 >=150, 블랭크(테마)면 <80.
CONTENT_BOX = (0.45, 0.30, 0.95, 0.85)
def render_check(window, name, expect_light=True, save=None):
    r = rpc("window.snapshot", {"base64": True}, window)
    png = base64.b64decode(r["media"]["base64"])
    if save or KEEP:
        p = os.path.join(TMP, f"{save or name}.png"); open(p, "wb").write(png)
    b = png_brightness(png, CONTENT_BOX)
    lit = b >= 150
    if lit == expect_light: ok(f"{name}: 렌더 판정 통과(밝기 {b:.0f})")
    else: ng(f"{name}: 렌더 실패(밝기 {b:.0f} — {'블랭크' if expect_light else '예상외 밝음'}) [{TMP}]")

def nav(window, plugin, url):
    for _ in range(24):
        r = rpc(f"plugin.{plugin}.navigate", {"url": url}, window)
        if r.get("ok"): return True
        time.sleep(0.5)
    return False

# ── 0. 준비 ─────────────────────────────────────────────────────────────────
if not app_alive():
    launch()
assert wait_socket(), "앱 소켓 없음"
ra = "/tmp/soksak-e2e-brestore-a"; rb = "/tmp/soksak-e2e-brestore-b"
os.makedirs(ra, exist_ok=True); os.makedirs(rb, exist_ok=True)

# 잔재 창 정리(멱등 재실행 대비): 이전 실행이 남긴 brestore 창을 먼저 닫는다.
def owners():
    t = rpc("window.list"); labs = t["labels"]
    res = {}
    for l in labs:
        if l == "main" or l.startswith("orch-"): continue
        try:
            tr = rpc("state.tree", window=l)
            for p in tr.get("projects", []):
                if "brestore" in p.get("root", ""): res[l] = p["root"]
        except Exception: pass
    return res
for l in owners():
    rpc("window.close", {"label": l}); time.sleep(0.5)

# ── 1. 두 창 + 양 엔진 브라우저 3개 ──────────────────────────────────────────
wa = rpc("window.new", {"root": ra}).get("label"); time.sleep(4)
wb = rpc("window.new", {"root": rb}).get("label"); time.sleep(4)
assert wa and wb, "창 생성 실패"
ok(f"창 2개 생성({wa},{wb} — 임시 root, 사용자 워크스페이스 무접촉)")

va_n = rpc("view.open", {"program": "browser"}, wa).get("viewId"); time.sleep(2)
assert nav(wa, "soksak-plugin-browser-native", "https://example.com"), "WA native nav 실패"
va_c = rpc("view.open", {"program": "browser-chromium"}, wa).get("viewId"); time.sleep(3)
assert nav(wa, "soksak-plugin-browser-chromium", "https://example.org"), "WA chromium nav 실패"
vb_n = rpc("view.open", {"program": "browser"}, wb).get("viewId"); time.sleep(2)
assert nav(wb, "soksak-plugin-browser-native", "https://example.net"), "WB native nav 실패"
ok(f"브라우저 3개(native×2+chromium×1) 탐색 완료")
time.sleep(3)

# ── 2. 종료 전: 창을 오가며 각 브라우저 렌더 확인 ────────────────────────────
rpc("window.focus", {"label": wa}); rpc("view.activate", {"view": va_c}, wa); time.sleep(2)
render_check(wa, "종료전 WA chromium(example.org)", save="pre-wa-chromium")
rpc("view.activate", {"view": va_n}, wa); time.sleep(2)
render_check(wa, "종료전 WA native(example.com)", save="pre-wa-native")
rpc("window.focus", {"label": wb}); rpc("view.activate", {"view": vb_n}, wb); time.sleep(2)
render_check(wb, "종료전 WB native(example.net)", save="pre-wb-native")
# 종료 시 활성: WA=native(→ chromium 은 복원 시 cold 승격 경로 검증), WB=native.
rpc("window.focus", {"label": wa}); time.sleep(1.5)  # 자동저장 디바운스 정착

# ── 3. 종료(보존 경로) → 재기동 → 복원 ──────────────────────────────────────
terminate()
launch()
labs = rpc("window.list")["labels"]
if wa in labs and wb in labs: ok(f"복원: 창 리스폰({wa},{wb})")
else: ng(f"복원: 창 리스폰 실패(현재 {labs})"); sys.exit_code = 1
time.sleep(4)  # 각 창 부트·hydration 정착

# ── 4. 복원 후: 창을 오가며 각 브라우저 렌더 확인 ────────────────────────────
rpc("window.focus", {"label": wa}); rpc("view.activate", {"view": va_n}, wa); time.sleep(5)
render_check(wa, "복원후 WA native(example.com)", save="post-wa-native")
rpc("view.activate", {"view": va_c}, wa); time.sleep(9)  # cold 승격+CEF 첫 페인트
render_check(wa, "복원후 WA chromium(example.org) — cold 승격", save="post-wa-chromium")
rpc("window.focus", {"label": wb}); rpc("view.activate", {"view": vb_n}, wb); time.sleep(5)
render_check(wb, "복원후 WB native(example.net)", save="post-wb-native")
rpc("window.focus", {"label": wa}); time.sleep(1)
render_check(wa, "복원후 재왕래 WA(chromium 유지)", save="post-wa-back")

# ── 5. 정리(멱등) ────────────────────────────────────────────────────────────
for l in (wa, wb):
    rpc("window.close", {"label": l}); time.sleep(0.5)
labs = rpc("window.list")["labels"]
(ok if wa not in labs and wb not in labs else ng)("정리: 테스트 창 닫힘(스냅샷 prune)")
# recents 위생(T5) — 이 하니스의 임시 root 만 잊는다(사용자 recents 무접촉).
for r0 in (ra, rb):
    rpc("project.recent.forget", {"root": r0})

print()
print(f"browser-restore: PASS={len(PASS)} FAIL={len(FAIL)}" + (f"  캡처={TMP}" if KEEP or FAIL else ""))
sys.exit(0 if not FAIL else 1)
PYEOF
