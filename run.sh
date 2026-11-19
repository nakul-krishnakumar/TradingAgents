#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"
export TZ=Asia/Kolkata
port="${TRADINGAGENTS_PORT:-8765}"
mode=local

if [[ $# -eq 1 && "$1" == --tunnel ]]; then
  mode=tunnel
elif [[ $# -ne 0 ]]; then
  printf '%s\n' 'Usage: ./run.sh [--tunnel]' >&2
  exit 2
fi

if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  printf '%s\n' 'TRADINGAGENTS_PORT must be a port from 1 to 65535.' >&2
  exit 2
fi

if [[ ! -x .venv/bin/python ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.13 .venv
  else
    python3 -m venv .venv
  fi
fi
python="$repo_dir/.venv/bin/python"

port_status=0
"$python" - "$port" "$mode" <<'PY' || port_status=$?
import json
import socket
import sys
from urllib.request import urlopen

port = int(sys.argv[1])
url = f"http://127.0.0.1:{port}"
with socket.socket() as probe:
    probe.settimeout(0.8)
    if probe.connect_ex(("127.0.0.1", port)):
        sys.exit(0)
if sys.argv[2] == "tunnel":
    sys.exit(f"Port {port} is in use. Stop the running server before enabling the tunnel.")
try:
    with urlopen(f"{url}/api/settings", timeout=1) as response:
        settings = json.load(response)
    if {"providers", "today", "watchlist"}.issubset(settings):
        print(f"Market Desk is already running at {url}/")
        sys.exit(10)
except (OSError, ValueError, TypeError):
    pass
sys.exit(f"Port {port} is in use. Set TRADINGAGENTS_PORT to an available local port.")
PY
if [[ "$port_status" == 10 ]]; then
  exit 0
elif [[ "$port_status" != 0 ]]; then
  exit "$port_status"
fi

if ! "$python" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
  printf '%s\n' 'Market Desk requires Python 3.11 or newer in .venv.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 20.19+ or 22.12+ and npm to build Market Desk.' >&2
  exit 1
fi

python_ready=.venv/.market-desk-installed
if [[ ! -f "$python_ready" || pyproject.toml -nt "$python_ready" || requirements.txt -nt "$python_ready" ]] ||
  ! "$python" -c 'import fastapi, uvicorn, openpyxl, langgraph, yfinance' >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$python" -r requirements.txt
  else
    "$python" -m pip install -r requirements.txt
  fi
  touch "$python_ready"
fi

if [[ ! -x web/node_modules/.bin/vite || ! -f web/node_modules/.package-lock.json ||
      web/package-lock.json -nt web/node_modules/.package-lock.json ]]; then
  npm --prefix web ci --include=dev
fi
npm --prefix web run build

if [[ "$mode" == tunnel ]]; then
  exec "$python" -m tradingagents.dashboard.tunnel "$port"
fi

printf '\nMarket Desk is starting at http://127.0.0.1:%s/\n' "$port"
printf '%s\n' 'The NSE market-day scheduler runs in this server. Press Ctrl+C to stop.'
export TRADINGAGENTS_QUICK_TUNNEL=0
exec "$python" -m uvicorn tradingagents.dashboard.api:app --host 127.0.0.1 --port "$port" --no-access-log
