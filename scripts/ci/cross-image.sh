#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image=wails-cross:latest
go_version=$(awk '$1 == "go" { print $2; count++ } END { if (count != 1) exit 1 }' "$root/go.mod")
dockerfile=$root/build/docker/Dockerfile.cross
definition=$(printf '%s\n' "$go_version" "$(shasum -a 256 "$dockerfile" | awk '{print $1}')" | shasum -a 256 | awk '{print $1}')
current=$(docker image inspect "$image" --format '{{index .Config.Labels "io.soksak.cross.definition-sha"}}' 2>/dev/null || true)
if [ "$current" = "$definition" ]; then
  exit 0
fi
docker build \
  --build-arg "GO_VERSION=$go_version" \
  --build-arg "CROSS_DEFINITION_SHA=$definition" \
  -t "$image" \
  -f "$dockerfile" \
  "$root/build/docker"
