#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
arm=$root/bin/release/darwin-arm64
x86=$root/bin/release/darwin-x86_64
output=$root/bin/release/darwin-universal
stage=$root/bin/release/.darwin-universal.next
cd "$root"
source_commit=$(git rev-parse HEAD)
test -n "$source_commit" && test -z "$(git status --porcelain --untracked-files=all)" || {
  echo "PRECONDITION_INVALID: Darwin universal composition requires a clean source commit" >&2
  exit 78
}
for input in "$arm" "$x86"; do
  test -d "$input/soksak.app" && test -x "$input/sok" && test -f "$input/build-evidence.json"
done
arm_commit=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sourceCommit)' "$arm/build-evidence.json")
x86_commit=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sourceCommit)' "$x86/build-evidence.json")
test "$arm_commit" = "$source_commit" && test "$x86_commit" = "$source_commit" || {
  echo "PRECONDITION_INVALID: Darwin thin artifacts do not match source $source_commit" >&2
  exit 78
}
test "$(lipo -archs "$arm/soksak.app/Contents/MacOS/soksak")" = arm64
test "$(lipo -archs "$arm/sok")" = arm64
test "$(lipo -archs "$x86/soksak.app/Contents/MacOS/soksak")" = x86_64
test "$(lipo -archs "$x86/sok")" = x86_64
for relative in Contents/Info.plist Contents/Resources/icons.icns; do
  cmp "$arm/soksak.app/$relative" "$x86/soksak.app/$relative"
done
if [ -f "$arm/soksak.app/Contents/Resources/Assets.car" ] || [ -f "$x86/soksak.app/Contents/Resources/Assets.car" ]; then
  cmp "$arm/soksak.app/Contents/Resources/Assets.car" "$x86/soksak.app/Contents/Resources/Assets.car"
fi

cleanup() { if [ -e "$stage" ]; then rm -rf "$stage"; fi; }
trap cleanup EXIT
cleanup
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
arm_app_sha=$(shasum -a 256 "$arm/soksak.app/Contents/MacOS/soksak" | awk '{print $1}')
arm_cli_sha=$(shasum -a 256 "$arm/sok" | awk '{print $1}')
x86_app_sha=$(shasum -a 256 "$x86/soksak.app/Contents/MacOS/soksak" | awk '{print $1}')
x86_cli_sha=$(shasum -a 256 "$x86/sok" | awk '{print $1}')
input_sha=$(printf '%s\n' "$arm_app_sha" "$arm_cli_sha" "$x86_app_sha" "$x86_cli_sha" | shasum -a 256 | awk '{print $1}')
app_sha=$(shasum -a 256 "$stage/soksak.app/Contents/MacOS/soksak" | awk '{print $1}')
cli_sha=$(shasum -a 256 "$stage/sok" | awk '{print $1}')
node -e '
  const fs = require("fs");
  const [out, sourceCommit, inputSHA256, applicationSHA256, clientSHA256] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({
    schema: "soksak-darwin-universal-build-v1", sourceCommit,
    target: "darwin/universal", inputSHA256, applicationSHA256, clientSHA256,
  }, null, 2) + "\n", { flag: "wx" });
' "$stage/build-evidence.json" "$source_commit" "$input_sha" "$app_sha" "$cli_sha"
if [ -f "$output/build-evidence.json" ]; then
  previous=$(node -e 'const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(`${v.sourceCommit}/${v.inputSHA256}`)' "$output/build-evidence.json")
  if [ "$previous" = "$source_commit/$input_sha" ]; then
    if ! diff -qr "$output" "$stage" >/dev/null; then
      echo "NONDETERMINISTIC_BUILD: darwin/universal differs for source $source_commit inputs $input_sha" >&2
      exit 1
    fi
    cleanup
    printf 'DARWIN_UNIVERSAL_REUSED sourceCommit=%s inputSHA256=%s appSHA256=%s cliSHA256=%s\n' "$source_commit" "$input_sha" "$app_sha" "$cli_sha"
    exit 0
  fi
fi
rm -rf "$output"
mv "$stage" "$output"
printf 'DARWIN_UNIVERSAL_READY sourceCommit=%s inputSHA256=%s appSHA256=%s cliSHA256=%s\n' "$source_commit" "$input_sha" "$app_sha" "$cli_sha"
