#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
for architecture in arm64 amd64; do
  "$root/scripts/ci/cross-build.sh" darwin "$architecture"
done
output=$root/bin/release/darwin-universal
bundle=$output/soksak.app
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
lipo -create -output "$bundle/Contents/MacOS/soksak" "$root/bin/cross/darwin-arm64/soksak" "$root/bin/cross/darwin-amd64/soksak"
lipo -create -output "$output/sok" "$root/bin/cross/darwin-arm64/sok" "$root/bin/cross/darwin-amd64/sok"
cp "$root/build/darwin/Info.plist" "$bundle/Contents/Info.plist"
cp "$root/build/darwin/icons.icns" "$bundle/Contents/Resources/icons.icns"
if [ -f "$root/build/darwin/Assets.car" ]; then cp "$root/build/darwin/Assets.car" "$bundle/Contents/Resources/Assets.car"; fi
for binary in "$bundle/Contents/MacOS/soksak" "$output/sok"; do
  test "$(lipo -archs "$binary")" = "x86_64 arm64"
done
