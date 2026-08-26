#!/bin/sh
set -eu
trap 'rm -f wails_windows_amd64.syso' EXIT

# Usage: windows-build.sh [generate|frontend|compile|all] [pnpm option ...]
# The options are forwarded to every pnpm invocation verbatim; make passes the scoped registry flags.
phase=${1:-all}
[ $# -eq 0 ] || shift
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

require_go() {
  required=$(awk '$1 == "go" { print "go" $2; count++ } END { if (count != 1) exit 1 }' go.mod)
  actual=$(go env GOVERSION)
  [ "$actual" = "$required" ] || { echo "$required is required; found $actual" >&2; exit 1; }
}

generate() {
  require_go
  go mod tidy -diff
  test -d frontend/bindings
  go tool wails3 generate syso -arch amd64 -icon build/windows/icon.ico -manifest build/windows/wails.exe.manifest -info build/windows/info.json -out wails_windows_amd64.syso
}

frontend() {
  node_version=$(cat .node-version)
  pnpm_version=$(node -p "require('./frontend/package.json').packageManager.split('@')[1]")
  [ "$(node --version)" = "v$node_version" ] || { echo "Node v$node_version is required" >&2; exit 1; }
  [ "$(pnpm --version)" = "$pnpm_version" ] || { echo "pnpm $pnpm_version is required" >&2; exit 1; }
  CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend "$@" install --frozen-lockfile
  CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend "$@" typecheck
  CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend "$@" build
  test -f frontend/dist/index.html
}

compile() {
  require_go
  test -f frontend/dist/index.html
  test -f wails_windows_amd64.syso
  mkdir -p bin
  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags production -trimpath -buildvcs=false -ldflags='-w -s -H windowsgui' -o bin/soksak.exe .
  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=false -o bin/sok.exe ./cmd/sok
  for binary in bin/soksak.exe bin/sok.exe; do
    test -s "$binary"
    go version -m "$binary" | grep -F 'GOOS=windows' >/dev/null
    go version -m "$binary" | grep -F 'GOARCH=amd64' >/dev/null
  done
}

case "$phase" in
  generate) generate ;;
  frontend) frontend "$@" ;;
  compile) compile ;;
  all) generate; frontend "$@"; compile ;;
  *) echo "usage: windows-build.sh [generate|frontend|compile|all] [pnpm option ...]" >&2; exit 2 ;;
esac
