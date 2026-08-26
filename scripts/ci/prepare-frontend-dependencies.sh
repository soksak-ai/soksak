#!/bin/sh
set -eu

# Usage: prepare-frontend-dependencies.sh [pnpm option ...]
# The options are forwarded to pnpm install verbatim; make passes the scoped registry flags.
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
lock=$root/.task/frontend-dependencies-owner.lock
mkdir -p "$(dirname -- "$lock")"

if [ "${1:-}" != "--locked" ]; then
  "$root/scripts/ci/check-frontend-toolchain.sh" --toolchain-only
  case "$(uname -s)" in
    Darwin) exec lockf -k "$lock" "$0" --locked "$@" ;;
    Linux) exec flock -x "$lock" "$0" --locked "$@" ;;
    MINGW*|MSYS*|CYGWIN*)
      export SOKSAK_PREPARE_FRONTEND=$root/frontend
      exec powershell.exe -NoProfile -Command '$owner=[Threading.Mutex]::new($false,"Global\soksak-frontend-dependencies-owner");$owner.WaitOne()|Out-Null;try{Set-Location $env:SOKSAK_PREPARE_FRONTEND;$env:CI="1";$env:PNPM_DISABLE_SELF_UPDATE_CHECK="1";pnpm '"$*"' install --frozen-lockfile;exit $LASTEXITCODE}finally{$owner.ReleaseMutex()}'
      ;;
    *) echo "PRECONDITION_INVALID: no dependency ownership primitive for $(uname -s)" >&2; exit 78 ;;
  esac
fi
shift

if ! (cd "$root/frontend" && CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm "$@" install --frozen-lockfile); then
  echo "DEPENDENCY_STATE_INVALID: exact frontend dependencies could not be materialized" >&2
  exit 79
fi
