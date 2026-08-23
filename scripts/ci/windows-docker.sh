#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
phase=${1:-all}
node_version=$(node -p "require('$root/frontend/package.json').engines.node")
pnpm_version=$(node -p "require('$root/frontend/package.json').packageManager.split('@')[1]")
image=soksak-windows-ci:wails-beta12

docker info >/dev/null
docker_arch=$(docker info --format '{{.Architecture}}')
case "$docker_arch" in aarch64|arm64) cross_arch=arm64 ;; x86_64|amd64) cross_arch=amd64 ;; *) echo "unsupported Docker architecture: $docker_arch" >&2; exit 1 ;; esac
"$root/scripts/ci/cross-image.sh" "$cross_arch"
cross_definition=$(docker image inspect "wails-cross-$cross_arch" --format '{{index .Config.Labels "io.soksak.cross.definition-sha"}}')
definition=$(printf '%s\n' "$cross_definition" "$node_version" "$pnpm_version" "$(shasum -a 256 "$root/build/docker/Dockerfile.windows-ci" | awk '{print $1}')" | shasum -a 256 | awk '{print $1}')
available=$(df -k "$root" | awk 'NR==2 {print $4}')
[ "$available" -ge 1048576 ] || { echo "at least 1 GiB host free space is required; Docker build caches use named volumes" >&2; exit 1; }

current=$(docker image inspect "$image" --format '{{index .Config.Labels "io.soksak.windows-ci.definition-sha"}}' 2>/dev/null || true)
if [ "$current" != "$definition" ]; then
  docker build --build-arg "CROSS_ARCH=$cross_arch" --build-arg "NODE_IMAGE=node:$node_version-bookworm" --build-arg "PNPM_VERSION=$pnpm_version" --build-arg CI_DEFINITION_SHA="$definition" -t "$image" -f "$root/build/docker/Dockerfile.windows-ci" "$root/build/docker"
fi

docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$root:/app" -v soksak-windows-ci-go-mod:/go/pkg/mod -v soksak-windows-ci-go-build:<local-evidence>/go-build \
  -v soksak-windows-ci-node-modules:/app/frontend/node_modules -v soksak-windows-ci-pnpm-store:/app/.pnpm-store \
  -e GOCACHE=<local-evidence>/go-build -e WAILS3=/usr/local/bin/wails3 --entrypoint /bin/sh "$image" \
  -e BUILD_PHASE="$phase" \
  -c 'mkdir -p <local-evidence>/home <local-evidence>/go-build /go/pkg/mod /app/.pnpm-store /app/frontend/node_modules && chown -R "$HOST_UID:$HOST_GID" <local-evidence>/home <local-evidence>/go-build /go/pkg/mod /app/.pnpm-store /app/frontend/node_modules && exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups env HOME=<local-evidence>/home GOCACHE=<local-evidence>/go-build WAILS3=/usr/local/bin/wails3 /bin/sh -c "cd /app && scripts/ci/windows-build.sh $BUILD_PHASE"'
