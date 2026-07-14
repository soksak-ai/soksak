#!/bin/bash
set -euo pipefail

# 실물 바이너리를 같은 디렉터리의 임시 regular file에 설치한 뒤 rename한다.
# destination이 기존 symlink여도 따라가지 않고 directory entry 자체를 교체한다.
src="${1:?source file required}"
dest="${2:?destination required}"

if [[ ! -f "$src" || -L "$src" ]]; then
  echo "install: source must be a regular non-symlink file: $src" >&2
  exit 1
fi

parent="$(dirname "$dest")"
if [[ ! -d "$parent" ]]; then
  echo "install: destination directory does not exist: $parent" >&2
  exit 1
fi

tmp="$(mktemp "$parent/.soksak-install.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
/usr/bin/install -m 0755 "$src" "$tmp"
mv -f "$tmp" "$dest"

if [[ ! -f "$dest" || -L "$dest" ]]; then
  echo "install: destination is not a regular file: $dest" >&2
  exit 1
fi

