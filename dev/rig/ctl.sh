#!/usr/bin/env bash
# Test rig: Towerlog on http://127.0.0.1:18091 (RIG_PORT=8080 to change the port, RIG_HOST=0.0.0.0 to listen on every interface) (password testpass123) with fake feeds,
# and an ffmpeg Icecast push standing in for an encoder. State is in dev/rig/build/.
#
#   dev/rig/ctl.sh start     build if needed, start the feeds, Towerlog and the push
#   dev/rig/ctl.sh stop      stop everything
#   dev/rig/ctl.sh status    what is running
#   dev/rig/ctl.sh logs      follow the Towerlog log
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
B="$HERE/build"
mkdir -p "$B/data" "$B/logs" "$B/cfg"
export TOWERLOG_CONFIG="$B/cfg/config.json" TOWERLOG_DATA="$B/data" TOWERLOG_LOG_DIR="$B/logs"

pidf() { echo "$B/$1.pid"; }
running() { [ -f "$(pidf "$1")" ] && kill -0 "$(cat "$(pidf "$1")")" 2>/dev/null; }
launch() { local n=$1; shift; nohup "$@" >"$B/$n.log" 2>&1 & echo $! >"$(pidf "$n")"; }
halt() { running "$1" && kill "$(cat "$(pidf "$1")")" 2>/dev/null || true; rm -f "$(pidf "$1")"; }

case "${1:-}" in
  start)
    [ -f "$ROOT/dist/towerlog.mjs" ] || (cd "$ROOT" && npm run build)
    [ -f "$TOWERLOG_CONFIG" ] || cp "$HERE/config.json" "$TOWERLOG_CONFIG"
    echo testpass123 | node "$ROOT/dist/towerlog.mjs" set-password >/dev/null
    running feeds || launch feeds node "$HERE/feeds.mjs"
    sleep 1
    running towerlog || launch towerlog env PORT="${RIG_PORT:-18091}" HOST="${RIG_HOST:-127.0.0.1}" node "$ROOT/dist/towerlog.mjs"
    for _ in $(seq 40); do (exec 3<>/dev/tcp/127.0.0.1/18000) 2>/dev/null && break; sleep 0.5; done   # wait for the source port
    running push || launch push ffmpeg -loglevel error -re -f lavfi -i "sine=frequency=330:sample_rate=44100" -c:a libmp3lame -b:a 64k -f mp3 -content_type audio/mpeg -password pw icecast://127.0.0.1:18000/kutx
    echo "Towerlog: http://127.0.0.1:${RIG_PORT:-18091}  (password testpass123)" ;;
  stop) for n in push towerlog feeds; do halt "$n"; done; echo stopped ;;
  status) for n in feeds towerlog push; do running "$n" && echo "$n: running" || echo "$n: stopped"; done ;;
  logs) exec tail -f "$B/logs/towerlog.log" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
