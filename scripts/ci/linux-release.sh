#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
architecture=${1:-}
case "$architecture" in amd64|arm64) ;; *) echo "usage: linux-release.sh <amd64|arm64>" >&2; exit 2 ;; esac
required=$(awk '$1 == "go" { print "go" $2; count++ } END { if (count != 1) exit 1 }' go.mod)
actual=$(go env GOVERSION)
[ "$actual" = "$required" ] || { echo "$required is required; found $actual" >&2; exit 1; }
case "$(uname -m)/$architecture" in x86_64/amd64|aarch64/arm64|arm64/arm64) ;; *) echo "native Linux $architecture runner is required" >&2; exit 1 ;; esac
scripts/ci/frontend-build.sh
output=bin/release/linux-$architecture
mkdir -p "$output"
log=$output/build.log
if ! CGO_ENABLED=1 GOOS=linux GOARCH=$architecture go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" -o "$output/soksak" . >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
if grep -F 'warning:' "$log" >/dev/null; then cat "$log" >&2; exit 1; fi
CGO_ENABLED=0 GOOS=linux GOARCH=$architecture go build -trimpath -buildvcs=false -ldflags="-w -s" -o "$output/sok" ./cmd/sok
file "$output/soksak" "$output/sok"
for binary in "$output/soksak" "$output/sok"; do
  go version -m "$binary" | grep -F "GOOS=linux" >/dev/null
  go version -m "$binary" | grep -F "GOARCH=$architecture" >/dev/null
done
readelf --version-info "$output/soksak" | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' | sort -Vu | tail -n 1 > "$output/glibc-max.txt"
test -s "$output/glibc-max.txt"
