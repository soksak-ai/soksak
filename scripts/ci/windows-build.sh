#!/bin/sh
set -eu
trap 'rm -f wails_windows_amd64.syso' EXIT

phase=${1:-all}
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

require_go() {
  required=$(awk '$1 == "go" { print "go" $2; count++ } END { if (count != 1) exit 1 }' go.mod)
  actual=$(go env GOVERSION)
  [ "$actual" = "$required" ] || { echo "$required is required; found $actual" >&2; exit 1; }
}

require_wails() {
  wails=${WAILS3:-$(command -v wails3 || true)}
  if command -v cygpath >/dev/null 2>&1 && [ -n "$wails" ]; then wails=$(cygpath -u "$wails"); fi
  if [ -z "$wails" ] || [ "$("$wails" version 2>&1)" != "v3.0.0-beta.12" ]; then
    echo "Wails v3.0.0-beta.12 is required" >&2
    exit 1
  fi
}

generate() {
  require_go
  require_wails
  go mod tidy -diff
  test -d frontend/bindings
  "$wails" generate syso -arch amd64 -icon build/windows/icon.ico -manifest build/windows/wails.exe.manifest -info build/windows/info.json -out wails_windows_amd64.syso
}

frontend() {
  node_version=$(node -p "require('./frontend/package.json').engines.node")
  pnpm_version=$(node -p "require('./frontend/package.json').packageManager.split('@')[1]")
  [ "$(node --version)" = "v$node_version" ] || { echo "Node v$node_version is required" >&2; exit 1; }
  [ "$(pnpm --version)" = "$pnpm_version" ] || { echo "pnpm $pnpm_version is required" >&2; exit 1; }
  pnpm --dir frontend install --frozen-lockfile
  pnpm --dir frontend typecheck
  pnpm --dir frontend build
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
  frontend) frontend ;;
  compile) compile ;;
  all) generate; frontend; compile ;;
  *) echo "usage: windows-build.sh [generate|frontend|compile|all]" >&2; exit 2 ;;
esac
