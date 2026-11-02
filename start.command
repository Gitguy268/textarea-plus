#!/bin/bash
# Double-click to run textarea: serves this folder on its own port and opens it.
#
# The editor needs a local server - from a file:// address the browser blocks
# its modules, its service worker and the speech engine. The port is fixed per
# copy of the project: two copies on one port share one service worker, and
# each one's cache would be served to the other.
cd "$(dirname "$0")" || exit 1
PORT=2502
URL="http://localhost:$PORT/"

if ! command -v node >/dev/null 2>&1; then
  echo "textarea needs Node.js to serve itself. Install it from https://nodejs.org and double-click start.command again."
  read -r -p "Press Return to close."
  exit 1
fi

open_app() {
  if [ -d "/Applications/Brave Browser.app" ]; then open -a "Brave Browser" "$URL"; else open "$URL"; fi
}

# Already running (a second double-click): just open it again.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open_app
  exit 0
fi

(sleep 1 && open_app) &
echo "textarea is at $URL - close this window to stop it."
PORT=$PORT exec node tests/serve.js
