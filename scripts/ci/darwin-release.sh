#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
release_arch=${1:-}
case "$release_arch" in
  arm64) go_arch=arm64; runner_arch=arm64; minimum=11.0 ;;
  x86_64) go_arch=amd64; runner_arch=x86_64; minimum=10.15 ;;
  *) echo "usage: darwin-release.sh <arm64|x86_64> <project-or-empty> [pnpm option ...]" >&2; exit 2 ;;
esac
shift
project=soksak
if [ "$#" -gt 0 ]; then
  project=${1:-soksak}
  shift
fi
case "$project" in soksak*) ;; *) echo 'Darwin project must start with soksak' >&2; exit 64 ;; esac
case "$project" in [a-z0-9]*) ;; *) echo 'Darwin project must start with a lowercase letter or digit' >&2; exit 64 ;; esac
case "$project" in *[!a-z0-9-]*) echo 'Darwin project may contain lowercase letters, digits, and hyphens only' >&2; exit 64 ;; esac
test "${#project}" -le 31 || { echo 'Darwin project must contain at most 31 bytes' >&2; exit 64; }
cd "$root"
project_identifier=com.$project.core
client=sok${project#soksak}
test "$(uname -m)" = "$runner_arch" || { echo "native Darwin $runner_arch runner is required" >&2; exit 78; }
source_commit=$(git rev-parse HEAD)
test -n "$source_commit" && test -z "$(git status --porcelain --untracked-files=all)" || {
  echo "PRECONDITION_INVALID: Darwin release requires a clean source commit" >&2
  exit 78
}
scripts/ci/check-build-toolchain.sh --toolchain-only
go mod download
scripts/ci/frontend-build.sh "$@"
scripts/ci/check-build-toolchain.sh

if [ "$project" = soksak ]; then
  output=bin/release/darwin-$release_arch
  stage=bin/release/.darwin-$release_arch.next
else
  output=bin/projects/$project/darwin-$release_arch
  stage=bin/projects/$project/.darwin-$release_arch.next
fi
cleanup() { if [ -e "$stage" ]; then rm -rf "$stage"; fi; }
trap cleanup EXIT
cleanup
mkdir -p "$stage/$project.app/Contents/MacOS" "$stage/$project.app/Contents/Resources"
mkdir -p .task/release
log=.task/release/darwin-$release_arch-$project.log
if ! MACOSX_DEPLOYMENT_TARGET=10.15 \
  CGO_ENABLED=1 GOOS=darwin GOARCH=$go_arch CC=clang \
  CGO_CFLAGS="-mmacosx-version-min=10.15" \
  CGO_LDFLAGS="-mmacosx-version-min=10.15 -Wl,-no_warn_duplicate_libraries" \
  go build -tags production -trimpath -buildvcs=false \
  -ldflags="-w -s -X github.com/soksak-ai/soksak-core/internal/application.defaultProcessLabel=$project -X github.com/soksak-ai/soksak-core/internal/application.defaultIdentifier=$project_identifier" \
  -o "$stage/$project.app/Contents/MacOS/$project" . >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
if grep -F 'warning:' "$log" >/dev/null; then cat "$log" >&2; exit 1; fi
CGO_ENABLED=0 GOOS=darwin GOARCH=$go_arch go build -trimpath -buildvcs=false \
  -ldflags="-w -s -X main.defaultIdentifier=$project_identifier" \
  -o "$stage/$client" ./cmd/sok
plist="$stage/$project.app/Contents/Info.plist"
cp build/darwin/Info.plist "$plist"
plutil -replace CFBundleName -string "$project" "$plist"
plutil -replace CFBundleDisplayName -string "$project" "$plist"
plutil -replace CFBundleExecutable -string "$project" "$plist"
plutil -replace CFBundleIdentifier -string "$project_identifier" "$plist"
cp build/darwin/icons.icns "$stage/$project.app/Contents/Resources/icons.icns"
if [ -f build/darwin/Assets.car ]; then cp build/darwin/Assets.car "$stage/$project.app/Contents/Resources/Assets.car"; fi

for binary in "$stage/$project.app/Contents/MacOS/$project" "$stage/$client"; do
  test "$(lipo -archs "$binary")" = "$runner_arch"
done
app_minimum=$(vtool -show-build "$stage/$project.app/Contents/MacOS/$project" | awk '$1 == "minos" { print $2 }')
test "$app_minimum" = "$minimum" || { echo "application targets macOS $app_minimum, want $minimum" >&2; exit 1; }
cli_minimum=$(vtool -show-build "$stage/$client" | awk '$1 == "minos" { print $2 }')
test "$cli_minimum" = 12.0 || { echo "client targets macOS $cli_minimum, want 12.0" >&2; exit 1; }
codesign --force --sign - "$stage/$client"
codesign --force --deep --sign - "$stage/$project.app"
codesign --verify --deep --strict "$stage/$project.app"
codesign --verify --strict "$stage/$client"
app_sha=$(shasum -a 256 "$stage/$project.app/Contents/MacOS/$project" | awk '{print $1}')
cli_sha=$(shasum -a 256 "$stage/$client" | awk '{print $1}')
node -e '
  const fs = require("fs");
  const [out, sourceCommit, architecture, applicationSHA256, clientSHA256, project, projectIdentifier, client] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({
    schema: "soksak-darwin-thin-build-v1", sourceCommit,
    target: `darwin/${architecture}`, project, projectIdentifier, client,
    applicationSHA256, clientSHA256,
  }, null, 2) + "\n", { flag: "wx" });
' "$stage/build-evidence.json" "$source_commit" "$release_arch" "$app_sha" "$cli_sha" "$project" "$project_identifier" "$client"
if [ -f "$output/build-evidence.json" ]; then
  previous_commit=$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sourceCommit)' "$output/build-evidence.json")
  if [ "$previous_commit" = "$source_commit" ]; then
    if ! diff -qr "$output" "$stage" >/dev/null; then
      echo "NONDETERMINISTIC_BUILD: darwin/$release_arch differs for source $source_commit" >&2
      exit 1
    fi
    cleanup
    printf 'DARWIN_THIN_REUSED sourceCommit=%s target=darwin/%s project=%s client=%s appSHA256=%s cliSHA256=%s\n' "$source_commit" "$release_arch" "$project" "$client" "$app_sha" "$cli_sha"
    exit 0
  fi
fi
rm -rf "$output"
mv "$stage" "$output"
printf 'DARWIN_THIN_READY sourceCommit=%s target=darwin/%s project=%s client=%s appSHA256=%s cliSHA256=%s\n' "$source_commit" "$release_arch" "$project" "$client" "$app_sha" "$cli_sha"
