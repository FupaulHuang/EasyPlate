#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

port="${EASYPLATE_PORT:-8765}"
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: bash start.sh [--port 8765]"
  exit 0
elif [[ $# -gt 0 ]]; then
  if [[ $# -ne 2 || "$1" != "--port" ]]; then
    echo "Usage: bash start.sh [--port 8765]" >&2
    exit 2
  fi
  port="$2"
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  echo "Port must be an integer from 1 to 65535." >&2
  exit 2
fi

python_bin="${EASYPLATE_PYTHON:-python3}"
if ! command -v "$python_bin" >/dev/null 2>&1 || \
   ! "$python_bin" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  echo "EasyPlate requires Python 3.10 or newer. Set EASYPLATE_PYTHON to a supported Python executable." >&2
  exit 1
fi

url="http://127.0.0.1:${port}"
"$python_bin" server.py --no-browser --port "$port" &
server_pid=$!
stop_server() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap stop_server EXIT INT TERM

# Give the local server time to bind before opening the page.
for _ in {1..20}; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then break; fi
  sleep 0.25
done
if ! kill -0 "$server_pid" 2>/dev/null; then
  wait "$server_pid"
  exit 1
fi

opened=0
if "$python_bin" -c 'import sys, webbrowser; sys.exit(0 if webbrowser.open(sys.argv[1], new=2) else 1)' "$url" >/dev/null 2>&1; then
  opened=1
fi

if [[ "$opened" == 1 ]]; then
  echo "Sent $url to this computer's browser handler."
else
  echo "No browser handler opened the page. Open $url on this computer."
fi
wait "$server_pid"
