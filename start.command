#!/bin/bash
# Mac: double-click to start Rabbit POS (same as start.bat on Windows). Add --demo to try it with the demo menu.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js is missing: install the LTS version from https://nodejs.org then double-click again."; read -n1; exit 1; fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a==22&&b>=13)?0:1)' || { echo "Node.js $(node -v) is too old: install the LTS version from https://nodejs.org"; read -n1; exit 1; }
( sleep 2; open http://localhost:${PORT:-8080} ) &
while true; do node --no-warnings server/index.js "$@"; echo "POS stopped, restarting in 5 seconds..."; sleep 5; done
