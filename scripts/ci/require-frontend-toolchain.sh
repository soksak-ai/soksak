#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
manifest=$root/frontend/package.json
node_expected=$(sed -n 's/^[[:space:]]*"node": "\([^"]*\)".*/\1/p' "$manifest")
pnpm_expected=$(sed -n 's/^[[:space:]]*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$manifest")
[ -n "$node_expected" ] && [ -n "$pnpm_expected" ] || {
  echo "PRECONDITION_INVALID: frontend/package.json has no exact Node or pnpm version" >&2
  exit 78
}

case "$(uname -s)" in
  Darwin) host_platform=darwin ;;
  Linux) host_platform=linux ;;
  MINGW*|MSYS*|CYGWIN*) host_platform=win32 ;;
  *) echo "TOOLCHAIN_MISMATCH: unsupported host platform $(uname -s)" >&2; exit 78 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) host_arch=arm64 ;;
  x86_64|amd64) host_arch=x64 ;;
  *) echo "TOOLCHAIN_MISMATCH: unsupported host architecture $(uname -m)" >&2; exit 78 ;;
esac

node_actual=$(node --version 2>/dev/null || true)
pnpm_actual=$(pnpm --version 2>/dev/null || true)
node_platform=$(node -p 'process.platform' 2>/dev/null || true)
node_arch=$(node -p 'process.arch' 2>/dev/null || true)

if [ "$node_actual" != "v$node_expected" ] || [ "$pnpm_actual" != "$pnpm_expected" ] || \
   [ "$node_platform" != "$host_platform" ] || [ "$node_arch" != "$host_arch" ]; then
  echo "TOOLCHAIN_MISMATCH: expected node=v$node_expected pnpm=$pnpm_expected host=$host_platform/$host_arch; actual node=${node_actual:-missing} pnpm=${pnpm_actual:-missing} runtime=${node_platform:-unknown}/${node_arch:-unknown}" >&2
  exit 78
fi

if ! (cd "$root/frontend" && CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile); then
  echo "DEPENDENCY_STATE_INVALID: exact frontend dependencies could not be materialized" >&2
  exit 79
fi

runtime=$(cd "$root/frontend" && PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm exec vite --version 2>/dev/null || true)
case "$runtime" in
  *"$host_platform-$host_arch"*"node-v$node_expected"*) ;;
  *)
    echo "DEPENDENCY_STATE_INVALID: frontend native package selection does not match $host_platform/$host_arch with node-v$node_expected: ${runtime:-missing}" >&2
    exit 79
    ;;
esac

printf 'FRONTEND_TOOLCHAIN_READY node=v%s pnpm=%s runtime=%s/%s\n' \
  "$node_expected" "$pnpm_expected" "$host_platform" "$host_arch"
