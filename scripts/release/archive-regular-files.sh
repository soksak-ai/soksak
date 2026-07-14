#!/bin/bash
set -euo pipefail

# Usage: archive-regular-files.sh <source-dir> <output.tar.gz>
# source를 그대로 신뢰하거나 링크를 dereference하지 않는다. regular file과 directory만
# 새 staging에 복사한 뒤 archive한다.
src="${1:?source directory required}"
out="${2:?output archive required}"

src="$(cd "$src" && pwd -P)"
case "$out" in
  /*) ;;
  *) out="$(pwd -P)/$out" ;;
esac

bad_link="$(find "$src" -type l -print -quit)"
if [[ -n "$bad_link" ]]; then
  echo "archive: symlink 금지: $bad_link" >&2
  exit 1
fi

bad_hardlink="$(find "$src" -type f -links +1 -print -quit)"
if [[ -n "$bad_hardlink" ]]; then
  echo "archive: hardlink 금지: $bad_hardlink" >&2
  exit 1
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/soksak-archive.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

while IFS= read -r -d '' dir; do
  rel="${dir#"$src"}"
  mkdir -p "$stage$rel"
done < <(find "$src" -type d -print0)

while IFS= read -r -d '' file; do
  rel="${file#"$src"}"
  /usr/bin/install -m "$(stat -f '%Lp' "$file")" "$file" "$stage$rel"
done < <(find "$src" -type f -print0)

mkdir -p "$(dirname "$out")"
/usr/bin/tar -czf "$out" -C "$stage" .

