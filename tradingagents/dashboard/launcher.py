"""Launch the dashboard and its configured services from run.sh."""

import argparse
import os
import signal
import tarfile

from tradingagents.default_config import build_default_config

from . import tunnel
from .codex_service import managed_bridge


def launch(port: int, mode: str) -> int:
    with managed_bridge(build_default_config(), dashboard_port=port) as bridge_url:
        if bridge_url:
            print(f"Codex FastAPI bridge ready at {bridge_url}", flush=True)

        print("The NSE market-day scheduler runs in Market Desk. Press Ctrl+C to stop.", flush=True)
        if mode == "tunnel":
            return tunnel.main(port)

        print(f"Market Desk is starting at http://127.0.0.1:{port}/", flush=True)
        server = tunnel.start_dashboard(port, env={**os.environ, "TRADINGAGENTS_QUICK_TUNNEL": "0"})
        try:
            return server.wait()
        finally:
            tunnel.terminate(server)


def _stop(*_):
    raise KeyboardInterrupt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", type=int)
    parser.add_argument("mode", choices=("local", "tunnel"))
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, _stop)
    try:
        raise SystemExit(launch(args.port, args.mode))
    except KeyboardInterrupt:
        raise SystemExit(0) from None
    except (OSError, RuntimeError, tarfile.TarError, ValueError) as error:
        raise SystemExit(f"Market Desk could not start. {error}") from None
