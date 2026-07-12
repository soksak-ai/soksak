#!/bin/bash
# 터미널 엔진 유닛 교체(설치-시점) — soksak-sidecar-terminal-spec@1 은 한 도메인·여러 엔진 유닛
# (alacritty·wezterm)이고, 소비 플러그인은 유닛 하나를 스폰한다. 이 스텝은 한 identity 홈의
# 설치본을 한 엔진으로 정합시켜, e2e 배터리가 그 엔진의 끝단(실앱 복원)을 실측하게 한다.
#   ① 엔진 dist 를 identity 홈의 해석 경로에 원자 설치(코어 resolve_sidecar_cmd 규약:
#      <home>/sidecars/soksak-sidecar-terminal-<engine>/dist/soksak-sidecar-terminal-<engine>).
#   ② 소비 플러그인(terminal-xterm·terminal-ghostty) 설치본의 유닛 선택을 그 엔진으로 정합.
#   ③ 이전 엔진의 상주 사이드카·앱을 회수 — 새 엔진이 싱글톤 소켓을 신선 바인딩하게.
#
# 유닛 선택의 두 지점(현 계약 실측): plugin.json sidecars[].name 은 선언(consent·conformance)
# 이고, 런타임 스폰은 번들 상수 SIDECAR_NAME(app.process.spawn "sidecar:{name}", detached)이다 —
# 서비스 사이드카 스폰 경로엔 매니페스트 게이트가 없다(engine 모델 app.sidecar.open 만 게이트됨).
# 그래서 이 스텝은 둘을 함께 정합시킨다(선언≡실제 스폰). 하나만 바꾸면 선언과 스폰이 갈려
# 배터리가 조용히 엉뚱한 엔진을 시험한다.
#
# dev 정본(~/.soksak-dev) 불변 — 소스 dist 를 읽기만 한다. 쓰기는 대상 identity 홈에만.
# 멱등: 같은 엔진으로 두 번 = 같은 상태. 되돌림 = 인자만 바꾼다(예: alacritty).
#
# 사용: bash scripts/e2e/terminal-unit-swap.sh <wezterm|alacritty> [identity=debug]
set -euo pipefail

ENGINE="${1:?사용: terminal-unit-swap.sh <wezterm|alacritty> [identity]}"
IDENTITY="${2:-debug}"
case "$ENGINE" in wezterm | alacritty) ;; *) echo "알 수 없는 엔진: $ENGINE (wezterm|alacritty)" >&2; exit 2 ;; esac

DEV_HOME="$HOME/.soksak-dev"
if [ "$IDENTITY" = "app" ]; then HOME_DIR="$HOME/.soksak"; else HOME_DIR="$HOME/.soksak-$IDENTITY"; fi
UNIT="soksak-sidecar-terminal-$ENGINE"
REPO="$DEV_HOME/sidecars/$UNIT"

[ -f "$REPO/Cargo.toml" ] || { echo "RED: 엔진 repo 부재: $REPO" >&2; exit 1; }
[ -d "$HOME_DIR" ] || { echo "RED: identity 홈 부재: $HOME_DIR" >&2; exit 1; }

# 소스에서 현재 바이너리를 빌드해 설치한다 — repo 의 dist/ 를 그대로 쓰지 않는다: 그 dist 는
# 마지막 stage.sh 시점에 고정돼 이후 소스 수정(예: 데몬 부팅-핸드셰이크 retry) 을 안 담을 수
# 있고, 낡은 바이너리는 데몬 peering 에 실패해 배터리가 조용히 잘못된 것을 시험한다(기준 약화).
# 빌드는 스크래치 target 으로(캐시 재사용) — dev 정본(소스·staged dist)은 건드리지 않는다.
export PATH="$HOME/.cargo/bin:$PATH"
SCRATCH_TARGET="${TMPDIR:-/tmp}/soksak-unit-swap-target/$UNIT"
mkdir -p "$SCRATCH_TARGET"
echo "  빌드 중(현재 소스 → 스크래치 target): $UNIT"
( cd "$REPO" && CARGO_TARGET_DIR="$SCRATCH_TARGET" cargo build --release --bin "$UNIT" ) \
  || { echo "RED: 엔진 빌드 실패: $UNIT" >&2; exit 1; }
SRC_BIN="$SCRATCH_TARGET/release/$UNIT"
[ -x "$SRC_BIN" ] || { echo "RED: 빌드 산출물 부재: $SRC_BIN" >&2; exit 1; }

# ③ 이전 엔진의 상주 사이드카·앱 회수(이 identity 만 — 경로 프리픽스로 스코프). 새 엔진이
#    싱글톤 소켓을 신선 바인딩하게: 살아 있는 옛 사이드카가 있으면 새 엔진의 프로브가 즉시
#    종료해(계약 §2 싱글톤) 옛 엔진이 계속 서빙한다.
pkill -9 -f "soksak-$IDENTITY.app/Contents/MacOS" 2>/dev/null || true
pkill -9 -f "$HOME_DIR/sidecars/soksak-sidecar-terminal-" 2>/dev/null || true
# SIGKILL 은 소켓 파일을 안 지운다 — 남은 엔진-중립 서비스 소켓을 제거해 새 엔진이
# EADDRINUSE 없이 신선 바인딩하게(singleton_taken 의 stale-remove 를 동시 스폰 레이스에
# 맡기지 않는다). 소켓 이름에 엔진이 없다(계약 §4 — 한 identity 한 소켓).
rm -f "$HOME_DIR"/run/soksak-sidecar-terminal-p*.sock 2>/dev/null || true

# ① dist 원자 설치(in-place cp=서명/실행중 SIGKILL 위험 → tmp+mv).
DEST_DIR="$HOME_DIR/sidecars/$UNIT/dist"
mkdir -p "$DEST_DIR"
STAGE="$DEST_DIR/.$UNIT.staging.$$"
cp "$SRC_BIN" "$STAGE"
chmod +x "$STAGE"
mv -f "$STAGE" "$DEST_DIR/$UNIT"

# ② 소비 플러그인 설치본의 유닛 선택 정합(선언 + 번들 상수).
for P in terminal-xterm terminal-ghostty; do
  PDIR="$HOME_DIR/plugins/soksak-plugin-$P"
  [ -d "$PDIR" ] || continue
  # plugin.json sidecars[].name — terminal-spec 계약 항목만 겨눈다.
  PLUGIN_JSON="$PDIR/plugin.json" NEW_NAME="terminal-$ENGINE" python3 - <<'PY'
import json, os
p, name = os.environ["PLUGIN_JSON"], os.environ["NEW_NAME"]
d = json.load(open(p))
touched = 0
for s in d.get("sidecars", []):
    if str(s.get("interface", "")).startswith("soksak-sidecar-terminal-spec@"):
        s["name"] = name; touched += 1
assert touched == 1, f"{p}: terminal-spec sidecar 선언 {touched}개(1 기대)"
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2)
open(p, "a").write("\n")
PY
  # main.js 번들 상수 SIDECAR_NAME — 런타임 스폰(선언과 정합해야 실제 그 엔진을 스폰).
  MAIN_JS="$PDIR/main.js" NEW_NAME="terminal-$ENGINE" python3 - <<'PY'
import os, re
p, name = os.environ["MAIN_JS"], os.environ["NEW_NAME"]
s = open(p).read()
s2, n = re.subn(r'(SIDECAR_NAME\s*=\s*")terminal-[a-z0-9-]+(")', r'\g<1>' + name + r'\g<2>', s)
assert n == 1, f"{p}: SIDECAR_NAME 상수 {n}개(1 기대)"
open(p, "w").write(s2)
PY
done

echo "GREEN: 터미널 유닛 → terminal-$ENGINE ($IDENTITY 홈 설치본: dist + plugin.json + main.js 정합)"
