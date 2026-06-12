#!/usr/bin/env bash
# 타이틀바 로고 사전 렌더 마스크(24pt 1x/2x) 생성 — 멱등.
# 사유: 1x 디스플레이에서 실시간 벡터 래스터(WebKit)는 다운샘플 필터 선택권이
# 없어 소프트하다 — 고해상 → Lanczos + 언샤프로 미리 구워 mask-image 로 쓴다.
# 색은 CSS currentColor 가 소유(테마 연동 보존). 의존: rsvg-convert, imagemagick.
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC=src/assets/soksak_logo.svg
TMP=$(mktemp -d)
sed 's/var(--logo-color, currentColor)/#000000/' "$SRC" > "$TMP/black.svg"
rsvg-convert -h 240 "$TMP/black.svg" -o "$TMP/hi.png"
magick "$TMP/hi.png" -filter Lanczos -resize x24 -unsharp 0x0.6+0.8+0.01 src/assets/soksak_logo-24.png
magick "$TMP/hi.png" -filter Lanczos -resize x48 -unsharp 0x0.6+0.6+0.01 src/assets/soksak_logo-48.png
rm -rf "$TMP"
echo "생성: src/assets/soksak_logo-{24,48}.png"
