#!/bin/bash
# 터미널 엔진 유닛 교체(설치-시점) — soksak-sidecar-terminal-spec@1 은 한 도메인·여러 엔진 유닛이고,
# 소비 플러그인은 그중 하나를 스폰한다. 이 스텝은 한 identity 홈의 설치본을 한 엔진으로 정합시켜,
# e2e 배터리가 그 엔진의 끝단(실앱 복원)을 실측하게 한다.
#   ① 엔진 dist 를 identity 홈의 해석 경로에 원자 설치(코어 resolve_sidecar_cmd 규약:
#      <home>/sidecars/soksak-sidecar-terminal-<engine>/dist/soksak-sidecar-terminal-<engine>).
#   ② 소비 플러그인(terminal-xterm·terminal-ghostty) 설치본을 dev 정본에서 원자 배포하고,
#      그 매니페스트의 terminal-spec 유닛 선언만 그 엔진으로 바꾼다.
#   ③ 이전 엔진의 상주 사이드카·앱을 회수 — 새 엔진이 싱글톤 소켓을 신선 바인딩하게.
#
# 유닛 선택은 매니페스트 하나가 정한다: 플러그인이 자기 선언(sidecars[].name)을 코어에 물어
# 스폰하고, 코어는 선언되지 않은 유닛의 스폰을 거부한다. 그래서 이 스텝은 plugin.json 만 바꾼다.
# 번들에 유닛 이름이 상수로 박힌 옛 배포본은 매니페스트를 이기므로, 배포 후 그 잔재를 검사해
# 발견되면 즉사한다(조용히 엉뚱한 엔진을 시험하는 것이 가장 나쁜 결과다).
#
# dev 정본(~/.soksak-dev) 불변 — 소스를 읽기만 한다. 쓰기는 대상 identity 홈에만.
# 멱등: 같은 엔진으로 두 번 = 같은 상태. 되돌림 = 인자만 바꾼다(예: alacritty).
#
# 사용: bash scripts/e2e/terminal-unit-swap.sh <alacritty|wezterm|vt100|ghostty> [identity=debug]
set -euo pipefail

ENGINE="${1:?사용: terminal-unit-swap.sh <alacritty|wezterm|vt100|ghostty> [identity]}"
IDENTITY="${2:-debug}"
case "$ENGINE" in alacritty | wezterm | vt100 | ghostty) ;; *) echo "알 수 없는 엔진: $ENGINE" >&2; exit 2 ;; esac

DEV_HOME="$HOME/.soksak-dev"
if [ "$IDENTITY" = "app" ]; then HOME_DIR="$HOME/.soksak"; else HOME_DIR="$HOME/.soksak-$IDENTITY"; fi
UNIT="soksak-sidecar-terminal-$ENGINE"
REPO="$DEV_HOME/sidecars/$UNIT"
SRC_BIN="$REPO/dist/$UNIT"

[ -x "$SRC_BIN" ] || { echo "RED: 엔진 dist 없음 — 먼저 그 유닛에서 stage.sh: $SRC_BIN" >&2; exit 1; }

# ③(선행) 상주 사이드카·앱 회수 — 새 엔진이 소켓을 신선 바인딩하게.
pkill -f "soksak-sidecar-terminal-" 2>/dev/null || true
rm -f "$HOME_DIR"/run/soksak-sidecar-terminal-*.sock 2>/dev/null || true

# ① 엔진 dist 원자 설치.
DEST_DIR="$HOME_DIR/sidecars/$UNIT/dist"
mkdir -p "$DEST_DIR"
STAGE="$DEST_DIR/.$UNIT.staging.$$"
cp "$SRC_BIN" "$STAGE"
chmod +x "$STAGE"
mv -f "$STAGE" "$DEST_DIR/$UNIT"

# ② 소비 플러그인: dev 정본에서 원자 배포 + 매니페스트의 유닛 선언만 교체.
for P in terminal-xterm terminal-ghostty; do
  PDIR="$HOME_DIR/plugins/soksak-plugin-$P"
  SRC="$DEV_HOME/plugins/soksak-plugin-$P"
  [ -d "$PDIR" ] || continue
  [ -f "$SRC/main.js" ] || { echo "RED: dev 번들 없음(빌드 먼저): $SRC/main.js" >&2; exit 1; }

  for F in main.js plugin.json; do
    T="$PDIR/.$F.staging.$$"
    cp "$SRC/$F" "$T"
    mv -f "$T" "$PDIR/$F"
  done

  # 번들이 유닛 이름을 상수로 들고 있으면 매니페스트가 무력화된다 — 즉사.
  if grep -qE '"sidecar:terminal-[a-z0-9-]+"' "$PDIR/main.js"; then
    echo "RED: $P 번들에 유닛 이름이 리터럴로 박혀 있다 — 매니페스트가 유닛을 못 고른다." >&2
    exit 1
  fi

  # plugin.json sidecars[].name — terminal-spec 계약 항목만 겨눈다(유일한 선택 지점).
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
done

echo "GREEN: 터미널 유닛 → terminal-$ENGINE ($IDENTITY 홈: 엔진 dist + 플러그인 신선 배포 + 매니페스트 선언)"
