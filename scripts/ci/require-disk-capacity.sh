#!/bin/sh
set -eu

# Rebuilding four native targets and their toolchains peaked below this measured floor.
required_gib=10
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
available_kib=$(df -Pk "$root" | awk 'NR == 2 { print $4 }')
required_kib=$((required_gib * 1024 * 1024))
if [ "$available_kib" -lt "$required_kib" ]; then
  echo "at least $required_gib GiB free space is required before installing toolchains or building multiple targets" >&2
  exit 1
fi
printf 'disk capacity: %s KiB available, %s KiB required\n' "$available_kib" "$required_kib"
