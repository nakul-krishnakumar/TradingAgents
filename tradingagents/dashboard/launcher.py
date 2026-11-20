"""Launch the dashboard and its configured services from run.sh."""

import argparse
import logging
import os
import signal
import tarfile

from tradingagents.diagnostics import Redactor, configure_logging, event, exception_fields

from . import tunnel
from .codex_service import managed_bridge

logger = logging.getLogger(__name__)


def launch(port: int, mode: str) -> int:
    from tradingagents.default_config import build_default_config

    event(logger, "launcher.started", "Market Desk launcher started", mode=mode, port=port)
    with managed_bridge(build_default_config(), dashboard_port=port) as bridge_url:
        if bridge_url:
            print(f"Codex FastAPI bridge ready at {bridge_url}", flush=True)

        print("The NSE market-day scheduler runs in Market Desk. Press Ctrl+C to stop.", flush=True)
        if mode == "tunnel":
            return tunnel.main(port)

        print(f"Market Desk is starting at http://127.0.0.1:{port}/", flush=True)
        server = tunnel.start_dashboard(port, env={**os.environ, "TRADINGAGENTS_QUICK_TUNNEL": "0"})
        try:
            status = server.wait()
            event(logger, "launcher.dashboard_exited", "Market Desk process exited",
                  level=logging.ERROR if status else logging.INFO, exit_code=status)
            return status
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
    log_file = configure_logging("launcher")
    print(f"System event log: {log_file}", flush=True)
    try:
        raise SystemExit(launch(args.port, args.mode))
    except KeyboardInterrupt:
        event(logger, "launcher.stopped", "Market Desk launcher was stopped")
        raise SystemExit(0) from None
    except (OSError, RuntimeError, tarfile.TarError, ValueError) as error:
        event(logger, "launcher.failed", "Could not start Market Desk",
              level=logging.ERROR, **exception_fields(error, stack=True))
        raise SystemExit("Market Desk could not start. " + Redactor().text(str(error))) from None
