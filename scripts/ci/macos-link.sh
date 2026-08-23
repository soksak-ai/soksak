#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cache=$(mktemp -d)
trap 'rm -rf "$cache"' EXIT HUP INT TERM
output=$cache/link.log

if ! GOCACHE=$cache \
  MACOSX_DEPLOYMENT_TARGET=10.15 \
  CGO_CFLAGS='-O2 -g -mmacosx-version-min=10.15' \
  CGO_LDFLAGS='-O2 -g -mmacosx-version-min=10.15 -Wl,-no_warn_duplicate_libraries' \
  go test "$root/internal/repositorygate" -run '^TestWailsReleasePublishesTheCompleteVerifiedMatrix$' -count=1 >"$output" 2>&1; then
  cat "$output"
  exit 1
fi
if grep -F 'warning:' "$output" >/dev/null; then
  cat "$output"
  exit 1
fi
cat "$output"
