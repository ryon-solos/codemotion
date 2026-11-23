#!/usr/bin/env bash
# Code Motion launcher: starts the local server when it is not running, then opens it in an app window.
set -u
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/codemotion/config.json"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/codemotion"
PORT="${CODEMOTION_PORT:-}"
if [ -z "$PORT" ] && [ -f "$CONF" ]; then PORT="$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONF" | grep -o '[0-9]*$')"; fi
PORT="${PORT:-7790}"
URL="http://127.0.0.1:$PORT/"

say() { command -v notify-send >/dev/null && notify-send "Code Motion" "$1"; echo "Code Motion: $1" >&2; }
ping() { if command -v curl >/dev/null; then curl -fsS -m 1 "${URL}api/ping" >/dev/null 2>&1; else "$(sh "$DIR/bin/find-node.sh")" -e "fetch('${URL}api/ping').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; fi; }

if ! ping; then
  NODE="$(sh "$DIR/bin/find-node.sh")" || { say "Node.js 22 or newer is needed (run $DIR/setup.sh for help)"; exit 1; }
  mkdir -p "$CACHE"
  nohup "$NODE" "$DIR/server/main.js" >"$CACHE/server.log" 2>&1 &
  for _ in $(seq 1 60); do ping && break; sleep 0.1; done
  ping || { say "The server did not start; see $CACHE/server.log"; exit 1; }
fi

[ "${1:-}" = "--server-only" ] && exit 0
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable brave-browser; do
  if command -v "$b" >/dev/null; then exec "$b" --app="$URL" --class=CodeMotion >/dev/null 2>&1; fi
done
exec xdg-open "$URL"
