#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
platform=${1:-}
architecture=${2:-}
case "$platform/$architecture" in
  darwin/arm64|darwin/amd64|linux/arm64|linux/amd64) ;;
  *) echo "usage: cross-build.sh <darwin|linux> <arm64|amd64>" >&2; exit 2 ;;
esac
"$root/scripts/ci/frontend-build.sh"
"$root/scripts/ci/cross-image.sh" "$architecture"

docker run --rm --platform "linux/$architecture" \
  -v "$root:/app" \
  -e APP_NAME=soksak -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "wails-cross-$architecture" "$platform" "$architecture"

application=$root/bin/cross/$platform-$architecture/soksak
client=$root/bin/cross/$platform-$architecture/sok
file "$application" "$client"
for binary in "$application" "$client"; do
  go version -m "$binary" | grep -F "GOOS=$platform" >/dev/null
  go version -m "$binary" | grep -F "GOARCH=$architecture" >/dev/null
done
if [ "$platform" = linux ]; then
  docker run --rm --platform "linux/$architecture" -v "$root:/app:ro" --entrypoint /bin/sh "wails-cross-$architecture" -c "readelf --version-info /app/bin/cross/$platform-$architecture/soksak | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' | sort -Vu | tail -n 1"
fi
