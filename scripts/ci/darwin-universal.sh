#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
arm=$root/bin/release/darwin-arm64
x86=$root/bin/release/darwin-x86_64
output=$root/bin/release/darwin-universal
stage=$root/bin/release/.darwin-universal.next
for input in "$arm" "$x86"; do
  test -d "$input/soksak.app" && test -x "$input/sok"
done
for relative in Contents/Info.plist Contents/Resources/icons.icns; do
  cmp "$arm/soksak.app/$relative" "$x86/soksak.app/$relative"
done
if [ -f "$arm/soksak.app/Contents/Resources/Assets.car" ] || [ -f "$x86/soksak.app/Contents/Resources/Assets.car" ]; then
  cmp "$arm/soksak.app/Contents/Resources/Assets.car" "$x86/soksak.app/Contents/Resources/Assets.car"
fi

rm -rf "$stage"
mkdir -p "$stage/soksak.app/Contents/MacOS" "$stage/soksak.app/Contents/Resources"
lipo -create -output "$stage/soksak.app/Contents/MacOS/soksak" \
  "$x86/soksak.app/Contents/MacOS/soksak" "$arm/soksak.app/Contents/MacOS/soksak"
lipo -create -output "$stage/sok" "$x86/sok" "$arm/sok"
cp "$arm/soksak.app/Contents/Info.plist" "$stage/soksak.app/Contents/Info.plist"
cp "$arm/soksak.app/Contents/Resources/icons.icns" "$stage/soksak.app/Contents/Resources/icons.icns"
if [ -f "$arm/soksak.app/Contents/Resources/Assets.car" ]; then
  cp "$arm/soksak.app/Contents/Resources/Assets.car" "$stage/soksak.app/Contents/Resources/Assets.car"
fi
for binary in "$stage/soksak.app/Contents/MacOS/soksak" "$stage/sok"; do
  test "$(lipo -archs "$binary")" = "x86_64 arm64"
done
codesign --force --sign - "$stage/sok"
codesign --force --deep --sign - "$stage/soksak.app"
codesign --verify --deep --strict "$stage/soksak.app"
codesign --verify --strict "$stage/sok"
rm -rf "$output"
mv "$stage" "$output"
