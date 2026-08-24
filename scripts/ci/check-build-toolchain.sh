#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "${1:-}" in
  ""|--toolchain-only) ;;
  *) echo "PRECONDITION_INVALID: usage: check-build-toolchain.sh [--toolchain-only]" >&2; exit 78 ;;
esac

if frontend=$($root/scripts/ci/check-frontend-toolchain.sh "${1:-}"); then
  printf '%s\n' "$frontend"
else
  status=$?
  exit "$status"
fi
required=$(printf '%s\n' "$frontend" | sed -n 's/.* required=\([^ ]*\).*/\1/p')
required_platform=${required%/*}
required_arch=${required#*/}
go_required_arch=$required_arch
if [ "$required_arch" = x86_64 ]; then go_required_arch=amd64; fi

go_expected=$(awk '$1 == "go" { value="go" $2; count++ } END { if (count == 1) print value; else exit 1 }' "$root/go.mod" 2>/dev/null || true)
go_actual=$(go env GOVERSION 2>/dev/null || true)
go_platform=$(go env GOHOSTOS 2>/dev/null || true)
go_arch=$(go env GOHOSTARCH 2>/dev/null || true)
wails_expected=$(awk '$1 == "github.com/wailsapp/wails/v3" { value=$2; count++ } END { if (count == 1) print value; else exit 1 }' "$root/go.mod" 2>/dev/null || true)

if [ "${1:-}" = "--toolchain-only" ]; then
  if [ -z "$required" ] || [ -z "$go_expected" ] || [ -z "$wails_expected" ] || \
     [ "$go_actual" != "$go_expected" ] || [ "$go_platform" != "$required_platform" ] || \
     [ "$go_arch" != "$go_required_arch" ]; then
    echo "TOOLCHAIN_MISMATCH: required=${required:-missing} expected go=${go_expected:-missing} wails=${wails_expected:-missing}; actual go=${go_actual:-missing} goRuntime=${go_platform:-unknown}/${go_arch:-unknown} wailsVersion=${wails_expected:-missing} wailsRuntime=deferred" >&2
    exit 78
  fi
  printf 'BUILD_TOOLCHAIN_READY required=%s go=%s goRuntime=%s/%s wailsVersion=%s wailsRuntime=deferred\n' \
    "$required" "$go_actual" "$go_platform" "$go_arch" "$wails_expected"
  exit 0
fi

wails_output=$(cd "$root" && go tool wails3 version 2>&1 || true)
wails_actual=$(printf '%s\n' "$wails_output" | awk '/^v[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$/ { value=$0; count++ } END { if (count == 1) print value; else exit 1 }' || true)
wails_binary=$(cd "$root" && go tool -n wails3 2>/dev/null || true)
wails_info=$([ -n "$wails_binary" ] && go version -m "$wails_binary" 2>/dev/null || true)
wails_platform=$(printf '%s\n' "$wails_info" | sed -n 's/^[[:space:]]*build[[:space:]]*GOOS=//p')
wails_arch=$(printf '%s\n' "$wails_info" | sed -n 's/^[[:space:]]*build[[:space:]]*GOARCH=//p')

if [ -z "$required" ] || [ -z "$go_expected" ] || [ -z "$wails_expected" ] || \
   [ "$go_actual" != "$go_expected" ] || [ "$go_platform" != "$required_platform" ] || \
   [ "$go_arch" != "$go_required_arch" ] || [ "$wails_actual" != "$wails_expected" ] || \
   [ "$wails_platform" != "$required_platform" ] || [ "$wails_arch" != "$go_required_arch" ]; then
  echo "TOOLCHAIN_MISMATCH: required=${required:-missing} expected go=${go_expected:-missing} wails=${wails_expected:-missing}; actual go=${go_actual:-missing} goRuntime=${go_platform:-unknown}/${go_arch:-unknown} wailsVersion=${wails_actual:-missing} wailsRuntime=${wails_platform:-unknown}/${wails_arch:-unknown}" >&2
  exit 78
fi

printf 'BUILD_TOOLCHAIN_READY required=%s go=%s goRuntime=%s/%s wailsVersion=%s wailsRuntime=%s/%s\n' \
  "$required" "$go_actual" "$go_platform" "$go_arch" "$wails_actual" "$wails_platform" "$wails_arch"
