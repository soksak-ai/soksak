#!/usr/bin/env bash
# 앱 아이콘 마스터(src-tauri/icons/icon.png) 재생성 — 멱등.
# 사유: 과거 마스터가 512px 수동 potrace 결과라 tauri icon 이 1024(.icns 512@2x)로
# 업스케일→레티나 독에서 뭉개졌다. SVG 원본에서 SOK 마크를 벡터로 다시 떠 1024 로
# 크리스프하게 합성한다. 단일 원본 = soksak_logo_ordered.svg(좌→우 정렬: 앞 3 path=S,O,K).
# 디자인 값은 직전 512 마스터 실측(×2): 여백 88 · 라운드사각 848² · 코너반경 188 ·
#   보더 #2a3140(10px) · 배경 #0b0f19 · 흰 SOK 폭 738 중앙 (모두 1024px 기준).
# 의존: rsvg-convert(librsvg), imagemagick(magick), python3.
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v rsvg-convert >/dev/null || { echo "rsvg-convert(librsvg) 필요"; exit 1; }
command -v magick       >/dev/null || { echo "ImageMagick(magick) 필요"; exit 1; }
command -v python3      >/dev/null || { echo "python3 필요"; exit 1; }

SVG=src/assets/logo-animated/soksak_logo_ordered.svg
OUT=src-tauri/icons/icon.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1) SOK(앞 3 path) 만 흰색으로 남긴 서브 SVG 생성
python3 - "$SVG" "$TMP/sok.svg" <<'PY'
import re, sys
svg = open(sys.argv[1]).read()
i = svg.index("<path")
header = svg[:i].replace("var(--logo-color, currentColor)", "#ffffff")
paths = re.findall(r"<path[^>]*/>", svg)
assert len(paths) >= 3, f"path {len(paths)}개 — 앞 3개(SOK) 부족"
open(sys.argv[2], "w").write(header + "".join(paths[:3]) + "</g></svg>")
PY

# 2) 고해상 래스터 + 여백 트림(마크 타이트 bbox)
rsvg-convert -w 2000 "$TMP/sok.svg" -o "$TMP/sok.png"
magick "$TMP/sok.png" -trim +repage "$TMP/sok-trim.png"

# 3) 라운드사각 배경(보더 링) + SOK 중앙 합성 → 1024 마스터
magick -size 1024x1024 xc:none \
  -fill '#2a3140' -draw "roundrectangle 88,88,935,935 188,188" \
  -fill '#0b0f19' -draw "roundrectangle 98,98,925,925 178,178" \
  "$TMP/bg.png"
magick "$TMP/bg.png" \
  \( "$TMP/sok-trim.png" -resize 738x \) -gravity center -composite \
  "$OUT"

echo "생성: $OUT ($(sips -g pixelWidth -g pixelHeight "$OUT" 2>/dev/null | awk '/pixel/{printf "%s ",$2}'))— SVG→SOK 벡터 1024"
