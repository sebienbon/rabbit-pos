#!/bin/bash
# Mac: double-click to start Rabbit POS (same as start.bat on Windows). Add --demo to try it with the demo menu.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js is missing: install the LTS version from https://nodejs.org then double-click again."; read -n1; exit 1; fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a==22&&b>=13)?0:1)' || { echo "Node.js $(node -v) is too old: install the LTS version from https://nodejs.org"; read -n1; exit 1; }
PORT=${PORT:-8080}
# An older Rabbit POS still running (another window, an earlier version)? Stop it; never touch another program.
for pid in $(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null); do
  if ps -p "$pid" -o command= | grep -q "server/index.js"; then echo "Stopping an older Rabbit POS ($pid)"; kill "$pid"; sleep 1;
  else echo "Port $PORT is used by another program: $(ps -p "$pid" -o comm=)"; read -n1; exit 1; fi
done
( sleep 2; open "http://localhost:$PORT" ) &
# POS_RESTART_ON_UPDATE: when new code arrives, the POS stops and this loop starts the new version.
export POS_RESTART_ON_UPDATE=1
while true; do
  node --no-warnings server/index.js "$@"; code=$?
  if [ $code -eq 75 ]; then echo "New version: restarting"; sleep 1; else echo "POS stopped, restarting in 5 seconds..."; sleep 5; fi
done
