#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
release_arch=${1:-}
case "$release_arch" in
  arm64) go_arch=arm64; runner_arch=arm64; minimum=11.0 ;;
  x86_64) go_arch=amd64; runner_arch=x86_64; minimum=10.15 ;;
  *) echo "usage: darwin-release.sh <arm64|x86_64>" >&2; exit 2 ;;
esac
cd "$root"
test "$(uname -m)" = "$runner_arch" || { echo "native Darwin $runner_arch runner is required" >&2; exit 78; }
scripts/ci/check-build-toolchain.sh --toolchain-only
scripts/ci/frontend-build.sh
scripts/ci/check-build-toolchain.sh

output=bin/release/darwin-$release_arch
stage=bin/release/.darwin-$release_arch.next
rm -rf "$stage"
mkdir -p "$stage/soksak.app/Contents/MacOS" "$stage/soksak.app/Contents/Resources"
log="$stage/build.log"
if ! MACOSX_DEPLOYMENT_TARGET=10.15 \
  CGO_ENABLED=1 GOOS=darwin GOARCH=$go_arch CC=clang \
  CGO_CFLAGS="-mmacosx-version-min=10.15" \
  CGO_LDFLAGS="-mmacosx-version-min=10.15 -Wl,-no_warn_duplicate_libraries" \
  go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" \
  -o "$stage/soksak.app/Contents/MacOS/soksak" . >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
if grep -F 'warning:' "$log" >/dev/null; then cat "$log" >&2; exit 1; fi
CGO_ENABLED=0 GOOS=darwin GOARCH=$go_arch go build -trimpath -buildvcs=false -ldflags="-w -s" -o "$stage/sok" ./cmd/sok
cp build/darwin/Info.plist "$stage/soksak.app/Contents/Info.plist"
cp build/darwin/icons.icns "$stage/soksak.app/Contents/Resources/icons.icns"
if [ -f build/darwin/Assets.car ]; then cp build/darwin/Assets.car "$stage/soksak.app/Contents/Resources/Assets.car"; fi

for binary in "$stage/soksak.app/Contents/MacOS/soksak" "$stage/sok"; do
  test "$(lipo -archs "$binary")" = "$runner_arch"
done
app_minimum=$(vtool -show-build "$stage/soksak.app/Contents/MacOS/soksak" | awk '$1 == "minos" { print $2 }')
test "$app_minimum" = "$minimum" || { echo "application targets macOS $app_minimum, want $minimum" >&2; exit 1; }
cli_minimum=$(vtool -show-build "$stage/sok" | awk '$1 == "minos" { print $2 }')
test "$cli_minimum" = 12.0 || { echo "client targets macOS $cli_minimum, want 12.0" >&2; exit 1; }
codesign --force --sign - "$stage/sok"
codesign --force --deep --sign - "$stage/soksak.app"
codesign --verify --deep --strict "$stage/soksak.app"
codesign --verify --strict "$stage/sok"
rm -rf "$output"
mv "$stage" "$output"
