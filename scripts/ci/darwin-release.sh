#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
required=$(awk '$1 == "go" { print "go" $2; count++ } END { if (count != 1) exit 1 }' go.mod)
actual=$(go env GOVERSION)
[ "$actual" = "$required" ] || { echo "$required is required; found $actual" >&2; exit 1; }
scripts/ci/frontend-build.sh
mkdir -p bin/native bin/release/darwin-universal
for architecture in arm64 amd64; do
  case "$architecture" in arm64) clang_arch=arm64; minimum=11.0 ;; amd64) clang_arch=x86_64; minimum=10.15 ;; esac
  log=bin/native/darwin-$architecture.log
  if ! MACOSX_DEPLOYMENT_TARGET=10.15 \
    CGO_ENABLED=1 GOOS=darwin GOARCH=$architecture CC=clang \
    CGO_CFLAGS="-arch $clang_arch -mmacosx-version-min=10.15" \
    CGO_LDFLAGS="-arch $clang_arch -mmacosx-version-min=10.15 -Wl,-no_warn_duplicate_libraries" \
    go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" -o "bin/native/soksak-$architecture" . >"$log" 2>&1; then
    cat "$log" >&2
    exit 1
  fi
  if grep -F 'warning:' "$log" >/dev/null; then cat "$log" >&2; exit 1; fi
  CGO_ENABLED=0 GOOS=darwin GOARCH=$architecture go build -trimpath -buildvcs=false -ldflags="-w -s" -o "bin/native/sok-$architecture" ./cmd/sok
  app_minimum=$(vtool -show-build "bin/native/soksak-$architecture" | awk '$1 == "minos" { print $2 }')
  [ "$app_minimum" = "$minimum" ] || { echo "application targets macOS $app_minimum, want $minimum" >&2; exit 1; }
  cli_minimum=$(vtool -show-build "bin/native/sok-$architecture" | awk '$1 == "minos" { print $2 }')
  [ "$cli_minimum" = 12.0 ] || { echo "client targets macOS $cli_minimum, want 12.0" >&2; exit 1; }
done
output=bin/release/darwin-universal
bundle=$output/soksak.app
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
lipo -create -output "$bundle/Contents/MacOS/soksak" bin/native/soksak-arm64 bin/native/soksak-amd64
lipo -create -output "$output/sok" bin/native/sok-arm64 bin/native/sok-amd64
cp build/darwin/Info.plist "$bundle/Contents/Info.plist"
cp build/darwin/icons.icns "$bundle/Contents/Resources/icons.icns"
if [ -f build/darwin/Assets.car ]; then cp build/darwin/Assets.car "$bundle/Contents/Resources/Assets.car"; fi
for binary in "$bundle/Contents/MacOS/soksak" "$output/sok"; do
  test "$(lipo -archs "$binary")" = "x86_64 arm64"
done
codesign --force --sign - "$output/sok"
codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
codesign --verify --strict "$output/sok"
