#!/usr/bin/env bash
# Corrupt-DB backup-ring recovery E2E — proves app.data survives a torn main file.
# The full lifecycle, driven end to end against a real app bundle:
#   1. reset the backup ring (fixture determinism — a fresh write must seed slot 0),
#   2. import a unique marker (a store write → emit_change → ring::on_write snapshot),
#   3. wait for soksak.db.bak.0 to appear (the write-triggered slot),
#   4. quit the app, overwrite soksak.db with garbage, drop the WAL/SHM sidecars,
#   5. relaunch the bundle fresh,
#   6. assert open_or_recover quarantined the torn file, restored slot 0, kept the
#      marker readable, and published a data.recovered activity entry.
# Idempotent: reuses ns p0-recovery and resets the ring each run; leaves the
# quarantined <db>.corrupt-<ms> file as post-mortem evidence (reported, not deleted).
#
# Usage: scripts/e2e/db-recovery.sh [--identity debug|release]   (default debug)
# Exit: 0=GREEN, 1=RED, 2=cannot run (missing bundle / app not up / no tools).

set -uo pipefail

IDENTITY="debug"
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# Build artifacts follow the cargo target-dir, which a worktree may redirect to a
# shared checkout (.cargo/config.toml) — resolve it so paths land on the real target.
TARGET="$REPO/src-tauri/target"
if [ -f "$REPO/.cargo/config.toml" ]; then
  TD=$(grep -E '^[[:space:]]*target-dir[[:space:]]*=' "$REPO/.cargo/config.toml" | head -1 | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/')
  [ -n "${TD:-}" ] && TARGET="$TD"
fi

case "$IDENTITY" in
  debug)
    HOME_DIR="$HOME/.soksak-debug"; IDENT="com.soksak.debug"
    SOK="$TARGET/debug/sok-debug"
    BUNDLE="$TARGET/debug/bundle/macos/soksak-debug.app" ;;
  release)
    HOME_DIR="$HOME/.soksak"; IDENT="com.soksak.app"
    SOK="$TARGET/release/sok"
    BUNDLE="$TARGET/release/bundle/macos/soksak.app" ;;
  *)
    echo "identity '$IDENTITY' has no launchable bundle (dev is HMR) — use debug or release" >&2
    exit 2 ;;
esac

SOCKET="$HOME_DIR/$IDENT.sock"
DB="$HOME_DIR/data/soksak.db"

command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
[ -x "$SOK" ] || { echo "sok binary missing: $SOK (build first)" >&2; exit 2; }
[ -d "$BUNDLE" ] || { echo "app bundle missing: $BUNDLE (build first)" >&2; exit 2; }

pass=0; fail=0
chk() { if [ "$1" = "1" ]; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ $2"; fi; }

# Readiness = the app answers system.hello. Never a bare sleep: poll the completion signal.
wait_hello() { # $1=deadline seconds
  local end=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    if "$SOK" hello >/dev/null 2>&1; then return 0; fi
    perl -e 'select(undef,undef,undef,0.4)'
  done
  return 1
}
wait_socket_gone() { # $1=deadline seconds
  local end=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    "$SOK" hello >/dev/null 2>&1 || return 0
    perl -e 'select(undef,undef,undef,0.4)'
  done
  return 1
}
wait_file() { # $1=path $2=deadline seconds
  local end=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ -s "$1" ] && return 0
    perl -e 'select(undef,undef,undef,0.4)'
  done
  return 1
}

echo "Corrupt-DB recovery E2E — identity=$IDENTITY"
echo "  home=$HOME_DIR  db=$DB"
echo

# ── precondition: app up ─────────────────────────────────────────────────────
if ! wait_hello 5; then
  echo "app is not answering on $SOCKET — launch it first" >&2
  exit 2
fi

# ── 1. reset the ring so a fresh write seeds slot 0 deterministically ─────────
echo "1. reset backup ring"
rm -f "$DB".bak.* "$DB".bak.tmp
chk "$([ -e "$DB.bak.0" ] && echo 0 || echo 1)" "no bak.0 before write"

# ── 2. write a unique marker (store write → on_write ring snapshot) ───────────
echo "2. import marker (store write)"
UNIQ="p0-recovery-$(date +%s)-$$"
JSONL=$(printf '%s\n%s' \
  '{"kind":"meta","ns":"p0-recovery","coll":"markers","idx":[],"fts":[]}' \
  "{\"kind\":\"record\",\"ns\":\"p0-recovery\",\"coll\":\"markers\",\"scope\":\"e2e\",\"id\":\"m1\",\"doc\":{\"marker\":\"$UNIQ\"}}")
REQ=$(jq -n --arg jsonl "$JSONL" '{jsonl:$jsonl}')
IMPORT_OK=$("$SOK" data.import "$REQ" 2>/dev/null | jq -r '.ok // false')
chk "$([ "$IMPORT_OK" = "true" ] && echo 1 || echo 0)" "data.import marker=$UNIQ (ok=$IMPORT_OK)"

# live read-back proves the marker is in the running store
LIVE=$("$SOK" data.query '{"ns":"p0-recovery","coll":"markers"}' 2>/dev/null | jq -r '.data.rows[0].marker // empty')
chk "$([ "$LIVE" = "$UNIQ" ] && echo 1 || echo 0)" "marker readable live (got '$LIVE')"

# ── 3. wait for the write-triggered slot ─────────────────────────────────────
echo "3. wait for backup ring slot 0 (write-triggered snapshot)"
if wait_file "$DB.bak.0" 20; then
  chk 1 "soksak.db.bak.0 created ($(stat -f '%z' "$DB.bak.0" 2>/dev/null) bytes)"
else
  chk 0 "soksak.db.bak.0 created"
fi

# ── 4. quit → corrupt → relaunch ─────────────────────────────────────────────
echo "4. quit app, corrupt soksak.db, relaunch"
osascript -e "tell application id \"$IDENT\" to quit" >/dev/null 2>&1
if wait_socket_gone 15; then chk 1 "app quit (socket down)"; else chk 0 "app quit (socket down)"; fi

printf 'this is definitely not a sqlite database' > "$DB"
rm -f "$DB-wal" "$DB-shm"
chk "$( [ "$(head -c 8 "$DB")" = "this is " ] && echo 1 || echo 0)" "soksak.db overwritten with garbage"

open -n "$BUNDLE"
if wait_hello 60; then chk 1 "app relaunched (answers hello)"; else chk 0 "app relaunched (answers hello)"; exit 1; fi

# ── 5. assert recovery ───────────────────────────────────────────────────────
echo "5. assert recovery"
RESTORED=$("$SOK" data.query '{"ns":"p0-recovery","coll":"markers"}' 2>/dev/null | jq -r '.data.rows[0].marker // empty')
chk "$([ "$RESTORED" = "$UNIQ" ] && echo 1 || echo 0)" "marker restored after corruption (got '$RESTORED')"

REC=$("$SOK" activity.recent '{"limit":80}' 2>/dev/null | jq -c '[.data.entries[] | select(.kind=="data.recovered")] | first // empty')
if [ -n "$REC" ] && [ "$REC" != "null" ]; then
  SLOT=$(echo "$REC" | jq -r '.payload.restoredFromSlot')
  QUAR=$(echo "$REC" | jq -r '.payload.quarantined')
  chk 1 "activity carries data.recovered (restoredFromSlot=$SLOT)"
  chk "$([ "$SLOT" = "0" ] && echo 1 || echo 0)" "restored from slot 0"
  chk "$([ -f "$QUAR" ] && echo 1 || echo 0)" "torn file quarantined for evidence: $QUAR"
  echo "  quarantined corrupt file left in place: $QUAR"
else
  chk 0 "activity carries data.recovered"
fi

echo
echo "result: $pass pass / $fail fail"
[ "$fail" -eq 0 ] && exit 0 || exit 1
