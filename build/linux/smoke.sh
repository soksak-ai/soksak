#!/bin/sh
set -eu

binary=${1:-/app/soksak}
client=${2:-/app/sok}
output=${3:-/evidence/soksak-linux.png}
native_output=${output%.png}-native.png
runtime=<local-evidence>/soksak-linux-smoke-runtime
persistent=<local-evidence>/soksak-linux-smoke-home
user_home=<local-evidence>/soksak-linux-smoke-user

test -x "$binary"
test -x "$client"
mkdir -p "$runtime" "$persistent" "$user_home" "$(dirname "$output")"

dbus-run-session -- xvfb-run -a -s "-screen 0 1400x900x24" sh -eu -c '
  binary=$1
  client=$2
  output=$3
  runtime=$4
  persistent=$5
  user_home=$6
  native_output=$7
  printf '\n' | gnome-keyring-daemon --unlock ><local-evidence>/soksak-keyring.env
  wm_ready=<local-evidence>/soksak-openbox-ready.$$
  mkfifo "$wm_ready"
  openbox --startup "sh -c \"printf ready\\\\n > $wm_ready\"" ><local-evidence>/soksak-openbox.log 2>&1 &
  read -r wm_status <"$wm_ready"
  rm -f "$wm_ready"
  test "$wm_status" = ready
  HOME=$user_home GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none LIBGL_ALWAYS_SOFTWARE=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
    SOKSAK_HOME=$persistent SOKSAK_RUNTIME=$runtime \
    SOKSAK_IDENTIFIER=com.soksak.linuxsmoke "$binary" > <local-evidence>/soksak-linux-smoke.log 2>&1 &
  pid=$!
  cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then cat <local-evidence>/soksak-linux-smoke.log >&2; fi
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    trap - EXIT INT TERM
    exit "$status"
  }
  trap cleanup EXIT INT TERM
  window=$(timeout 20 xdotool search --sync --onlyvisible --pid "$pid" | head -n 1)
  test -n "$window"
  socket=$runtime/com.soksak.linuxsmoke.sock
  attempt=0
  until "$client" --socket "$socket" window.list window=main >/dev/null 2>&1; do
    kill -0 "$pid"
    attempt=$((attempt + 1))
    test "$attempt" -lt 80
    sleep 0.25
  done
  "$client" --socket "$socket" plugin.boot.wait window=main timeoutMs=20000 >/dev/null
  tree=$("$client" --socket "$socket" ui.tree window=main)
  echo "$tree" | grep -Eq '"'"'"count"[[:space:]]*:[[:space:]]*[1-9]'"'"'
  xdotool windowsize "$window" 1400 900
  before=$(xdotool getwindowfocus)
  "$client" --socket "$socket" window.snapshot window=main path="$native_output" >/dev/null
  after=$(xdotool getwindowfocus)
  test "$before" = "$after"
  test -s "$native_output"
  import -window "$window" "$output"
  kill -0 "$pid"
' sh "$binary" "$client" "$output" "$runtime" "$persistent" "$user_home" "$native_output"

for capture in "$output" "$native_output"; do
  dimensions=$(identify -format '%wx%h' "$capture")
  colors=$(identify -format '%k' "$capture")
  width=${dimensions%x*}
  height=${dimensions#*x}
  test "$width" -ge 800
  test "$height" -ge 600
  test "$colors" -gt 16
  printf 'linux visual smoke: %s, %s, %s colors\n' "$(basename "$capture")" "$dimensions" "$colors"
done
