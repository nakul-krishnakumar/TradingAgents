#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"
export TZ=Asia/Kolkata
port="${TRADINGAGENTS_PORT:-8765}"
mode=local
startup_stage=arguments

log_setup() {
  local stage="$1" status="$2" log_python
  log_python="$repo_dir/.venv/bin/python"
  if [[ ! -x "$log_python" ]]; then
    log_python="$(command -v python3 || true)"
  fi
  if [[ -n "$log_python" ]]; then
    "$log_python" "$repo_dir/tradingagents/diagnostics.py" "$stage" "$status" || true
  fi
}

log_setup_exit() {
  local status="$1"
  if (( status != 0 )); then
    log_setup "$startup_stage" "$status"
  fi
}
trap 'log_setup_exit "$?"' EXIT

if [[ $# -eq 1 && "$1" == --tunnel ]]; then
  mode=tunnel
elif [[ $# -eq 1 && "$1" == --stop-tunnel ]]; then
  mode=stop-tunnel
elif [[ $# -ne 0 ]]; then
  printf '%s\n' 'Usage: ./run.sh [--tunnel | --stop-tunnel]' >&2
  exit 2
fi

if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
  printf '%s\n' 'TRADINGAGENTS_PORT must be a port from 1 to 65535.' >&2
  exit 2
fi

if [[ "$mode" == stop-tunnel ]]; then
  if [[ -x .venv/bin/python ]]; then
    exec .venv/bin/python -m tradingagents.dashboard.tunnel "$port" --stop
  fi
  printf '%s\n' 'No Market Desk tunnel is running.'
  exit 0
fi

startup_stage=python_environment
log_setup "$startup_stage" 0
if [[ ! -x .venv/bin/python ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.13 .venv
  else
    python3 -m venv .venv
  fi
fi
python="$repo_dir/.venv/bin/python"

port_status=0
startup_stage=port_check
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
node_is_supported() {
  command -v npm >/dev/null 2>&1 && node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
    process.exit(supported ? 0 : 1);
  ' >/dev/null 2>&1
}

startup_stage=node_runtime
if ! node_is_supported; then
  node_bin="$("$python" tradingagents/dashboard/node_runtime.py "$repo_dir/.venv")"
  export PATH="$node_bin:$PATH"
  if ! node_is_supported; then
    printf '%s\n' 'The downloaded Node.js could not run. Install Node.js 24 LTS with npm for your operating system.' >&2
    exit 1
  fi
fi

startup_stage=python_dependencies
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

startup_stage=web_dependencies
if [[ ! -x web/node_modules/.bin/vite || ! -f web/node_modules/.package-lock.json ||
      web/package-lock.json -nt web/node_modules/.package-lock.json ]]; then
  npm --prefix web ci --include=dev
fi
startup_stage=web_build
npm --prefix web run build

startup_stage=services
log_setup "$startup_stage" 0
exec "$python" -m tradingagents.dashboard.launcher "$port" "$mode"
