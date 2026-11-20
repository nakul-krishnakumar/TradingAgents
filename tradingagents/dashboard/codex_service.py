"""Start the loopback Codex bridge alongside Market Desk when selected."""

import http.client
import json
import logging
import os
import subprocess
import sys
from contextlib import contextmanager
from time import monotonic, sleep

from tradingagents.diagnostics import event
from tradingagents.llm_clients.codex_config import (
    HOST,
    KEY_ENV,
    PROVIDER,
    bridge_models,
    bridge_port,
    bridge_url,
)
from tradingagents.llm_clients.factory import tier_provider

logger = logging.getLogger(__name__)

def _ready(port, key, required_models):
    connection = http.client.HTTPConnection(HOST, port, timeout=0.3)
    try:
        connection.request("GET", "/health", headers={"Authorization": f"Bearer {key}"})
        response = connection.getresponse()
        if response.status != 200:
            return False
        health = json.loads(response.read(4096))
        if not isinstance(health, dict) or health.get("bridge") != "codex-exec":
            return False
        models = health.get("models", [health.get("model")])
        return isinstance(models, list) and all(model in models for model in required_models)
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


@contextmanager
def managed_bridge(config, *, dashboard_port=None):
    required_models = {
        config[f"{tier}_think_llm"] for tier in ("quick", "deep")
        if tier_provider(config, tier) == PROVIDER
    }
    if not required_models:
        yield
        return

    key = os.getenv(KEY_ENV)
    if not key or len(key) < 24 or not key.isascii() or any(char.isspace() for char in key):
        raise RuntimeError(
            f"Set {KEY_ENV} to a random token of at least 24 ASCII characters in .env."
        )
    if missing := required_models.difference(bridge_models()):
        raise RuntimeError(f"TRADINGAGENTS_CODEX_MODELS must include {', '.join(sorted(missing))}.")
    port = bridge_port()
    if port == dashboard_port:
        raise ValueError("TRADINGAGENTS_PORT and TRADINGAGENTS_CODEX_PORT must be different.")
    url = bridge_url()
    if _ready(port, key, required_models):
        event(logger, "launcher.codex_reused", "Using the running Codex bridge", port=port, models=sorted(required_models))
        yield url
        return

    process = subprocess.Popen([sys.executable, "-m", "tradingagents.dashboard.codex_bridge"])
    event(logger, "launcher.codex_started", "Codex bridge process started", port=port, pid=process.pid,
          models=sorted(required_models))
    try:
        deadline = monotonic() + 10
        while process.poll() is None and monotonic() < deadline:
            if _ready(port, key, required_models):
                event(logger, "launcher.codex_ready", "Codex bridge is ready", port=port, pid=process.pid)
                yield url
                return
            sleep(0.15)
        event(logger, "launcher.codex_failed", "Codex bridge did not become ready", port=port,
              level=logging.ERROR, exit_code=process.poll())
        raise RuntimeError(
            "The Codex bridge did not start. Check the Codex executable and bridge port."
        )
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        event(logger, "launcher.codex_exited", "Codex bridge process exited", pid=process.pid, exit_code=process.returncode)
