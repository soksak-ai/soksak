#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "${1:-}" in
  ""|--toolchain-only) ;;
  *) echo "PRECONDITION_INVALID: usage: check-frontend-toolchain.sh [--toolchain-only]" >&2; exit 78 ;;
esac
manifest=$root/frontend/package.json
lockfile=$root/frontend/pnpm-lock.yaml
selection=$root/.node-version
node_expected=$(awk 'NF { value=$0; count++ } END { if (count == 1) print value; else exit 1 }' "$selection" 2>/dev/null || true)
node_declared=$(sed -n 's/^[[:space:]]*"node": "\([^"]*\)".*/\1/p' "$manifest")
pnpm_expected=$(sed -n 's/^[[:space:]]*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$manifest")
if [ -z "$node_expected" ] || [ -z "$node_declared" ] || [ "$node_expected" != "$node_declared" ] || [ -z "$pnpm_expected" ]; then
  echo "PRECONDITION_INVALID: .node-version, frontend Node engine and pnpm declaration must be exact and aligned" >&2
  exit 78
fi

host_system=$(uname -s)
case "$host_system" in
  Darwin) required_platform=darwin ;;
  Linux) required_platform=linux ;;
  MINGW*|MSYS*|CYGWIN*) required_platform=win32 ;;
  *) echo "TOOLCHAIN_MISMATCH: unsupported host platform $host_system" >&2; exit 78 ;;
esac
host_machine=$(uname -m)
if [ "$required_platform" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
  required_arch=arm64
else
  case "$host_machine" in
    arm64|aarch64) required_arch=arm64 ;;
    x86_64|amd64) required_arch=x86_64 ;;
    *) echo "TOOLCHAIN_MISMATCH: unsupported host architecture $host_machine" >&2; exit 78 ;;
  esac
fi
node_required_arch=$required_arch
if [ "$required_arch" = x86_64 ]; then node_required_arch=x64; fi

node_actual=$(node --version 2>/dev/null || true)
pnpm_actual=$(cd "$root/frontend" && pnpm --version 2>/dev/null || true)
node_platform=$(node -p 'process.platform' 2>/dev/null || true)
node_arch=$(node -p 'process.arch' 2>/dev/null || true)
if [ "$node_actual" != "v$node_expected" ] || [ "$pnpm_actual" != "$pnpm_expected" ] || \
   [ "$node_platform" != "$required_platform" ] || [ "$node_arch" != "$node_required_arch" ]; then
  echo "TOOLCHAIN_MISMATCH: required=$required_platform/$required_arch expected node=v$node_expected pnpm=$pnpm_expected; actual node=${node_actual:-missing} pnpm=${pnpm_actual:-missing} nodeRuntime=${node_platform:-unknown}/${node_arch:-unknown}" >&2
  exit 78
fi

lock_digest=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$lockfile")
if [ "${1:-}" = "--toolchain-only" ]; then
  printf 'FRONTEND_TOOLCHAIN_READY required=%s/%s node=v%s nodeRuntime=%s/%s pnpm=%s lockSHA256=%s\n' \
    "$required_platform" "$required_arch" "$node_expected" "$node_platform" "$node_arch" "$pnpm_expected" "$lock_digest"
  exit 0
fi

vite_bin=$(cd "$root/frontend" && node -p 'require("./node_modules/vite/package.json").bin.vite' 2>/dev/null || true)
runtime=$(cd "$root/frontend" && [ -n "$vite_bin" ] && node "node_modules/vite/$vite_bin" --version 2>/dev/null || true)
case "$runtime" in
  *"$required_platform-$node_required_arch"*"node-v$node_expected"*) ;;
  *)
    echo "DEPENDENCY_STATE_INVALID: frontend native package selection does not match required=$required_platform/$required_arch nodeRuntime=$node_platform/$node_arch with node-v$node_expected: ${runtime:-missing}" >&2
    exit 79
    ;;
esac

printf 'FRONTEND_TOOLCHAIN_READY required=%s/%s node=v%s nodeRuntime=%s/%s pnpm=%s lockSHA256=%s\n' \
  "$required_platform" "$required_arch" "$node_expected" "$node_platform" "$node_arch" "$pnpm_expected" "$lock_digest"
