#!/bin/sh
set -eu

# Usage: frontend-build.sh [pnpm option ...]
# The options are forwarded to every pnpm invocation verbatim; make passes the scoped registry flags.
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
node_version=$(cat "$root/.node-version")
pnpm_version=$(sed -n 's/^[[:space:]]*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$root/frontend/package.json")
[ -n "$node_version" ] && [ -n "$pnpm_version" ] || { echo "frontend tool versions are missing" >&2; exit 1; }
dockerfile=$root/build/docker/Dockerfile.frontend
definition=$(printf '%s\n' "$node_version" "$pnpm_version" "$(shasum -a 256 "$dockerfile" | awk '{print $1}')" | shasum -a 256 | awk '{print $1}')
input=$(find "$root/frontend" -type f ! -path '*/dist/*' ! -path '*/node_modules/*' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')
marker=$root/frontend/dist/.build-input-sha256
if [ -s "$root/frontend/dist/index.html" ] && [ "$(cat "$marker" 2>/dev/null || true)" = "$definition:$input" ]; then
  exit 0
fi
image=soksak-frontend:latest
build_frontend() {
  cd "$root/frontend"
  pnpm "$@" install --frozen-lockfile
  pnpm "$@" typecheck
  pnpm "$@" build
}
pnpm_actual=$(cd "$root/frontend" && pnpm --version 2>/dev/null || true)
if [ "$(node --version 2>/dev/null || true)" = "v$node_version" ] && [ "$pnpm_actual" = "$pnpm_version" ]; then
  CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 build_frontend "$@"
  printf '%s\n' "$definition:$input" > "$marker"
  exit 0
fi
current=$(docker image inspect "$image" --format '{{index .Config.Labels "io.soksak.frontend.definition-sha"}}' 2>/dev/null || true)
if [ "$current" != "$definition" ]; then
  docker build \
    --build-arg "NODE_VERSION=$node_version" \
    --build-arg "PNPM_VERSION=$pnpm_version" \
    --build-arg "FRONTEND_DEFINITION_SHA=$definition" \
    -t "$image" -f "$dockerfile" "$root/build/docker"
fi
docker run --rm \
  -e CI=1 -e PNPM_DISABLE_SELF_UPDATE_CHECK=1 \
  -v "$root:/app" \
  -v soksak-frontend-node-modules:/app/frontend/node_modules \
  -v soksak-frontend-pnpm-store:/app/.pnpm-store \
  "$image" /bin/sh -c 'pnpm "$@" install --frozen-lockfile && pnpm "$@" typecheck && pnpm "$@" build' sh "$@"
printf '%s\n' "$definition:$input" > "$marker"
