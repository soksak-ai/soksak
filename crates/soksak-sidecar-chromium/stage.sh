#!/bin/bash
# dist 스테이징의 단일 진실 — dev(make sidecar-chromium)와 CI(release.yml)가 같은 스크립트를 쓴다.
# 사용: stage.sh <dist-dir>   (cargo build --release 선행 전제; 이 크레이트 디렉토리에서 실행)
set -euo pipefail
dist="${1:?사용: stage.sh <dist-dir>}"
src="target/release"

mkdir -p "$dist"
cp "$src/libsoksak_sidecar_chromium.dylib" "$dist/soksak-sidecar-chromium.dylib"

# helper .app 변형 5종 — Chromium 은 렌더러를 " Helper (Renderer).app" 형제 번들에서 띄운다
# (변형 부재 시 렌더러 spawn 이 조용히 실패 = 콘텐츠 blank, 실측).
for v in "" " (Renderer)" " (GPU)" " (Plugin)" " (Alerts)"; do
  app="$dist/soksak-sidecar-chromium Helper$v.app"
  exe="soksak-sidecar-chromium Helper$v"
  bid=$(printf '%s' "helper$v" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '.' | tr -s '.' | sed 's/\.$//')
  mkdir -p "$app/Contents/MacOS"
  cp "$src/soksak-sidecar-chromium-helper" "$app/Contents/MacOS/$exe"
  sed -e "s/__EXECUTABLE__/$exe/g" -e "s/__BUNDLE_ID_SUFFIX__/$bid/g" \
    resources/HelperInfo.plist > "$app/Contents/Info.plist"
done

# Chromium framework — cef 빌드 산출물(OUT_DIR)에서 심링크(아카이브는 tar -L 로 해소).
fw=$(ls -dt "$src/build/"cef-dll-sys-*/out/cef_macos_*/"Chromium Embedded Framework.framework" 2>/dev/null | head -1)
if [ -z "$fw" ]; then echo "framework 미발견(cef 빌드 산출물 없음)" >&2; exit 1; fi
ln -sfn "$(cd "$(dirname "$fw")" && pwd)/Chromium Embedded Framework.framework" "$dist/Chromium Embedded Framework.framework"
echo "스테이지 완료: $dist (helper 변형 5종)"
