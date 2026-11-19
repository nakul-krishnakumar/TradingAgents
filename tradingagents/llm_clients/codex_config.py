"""Connection settings shared by the Codex bridge and its clients."""

import os
from math import isfinite

PROVIDER = "codex"
KEY_ENV = "TRADINGAGENTS_CODEX_BRIDGE_KEY"
DEFAULT_MODEL = "gpt-6.2-sol"
DEFAULT_DEEP_MODEL = "gpt-6.2-astra"
DEFAULT_REASONING_EFFORT = "max"
DEFAULT_SERVICE_TIER = "ultrafast"
HOST = "127.0.0.1"


def bridge_models() -> tuple[str, ...]:
    if configured := os.getenv("TRADINGAGENTS_CODEX_MODELS"):
        names = (part.strip() for part in configured.split(","))
        models = tuple(dict.fromkeys(name for name in names if name))
        if not models:
            raise ValueError("TRADINGAGENTS_CODEX_MODELS must contain at least one model ID.")
        return models
    if model := os.getenv("TRADINGAGENTS_CODEX_MODEL"):
        return (model,)
    return DEFAULT_MODEL, DEFAULT_DEEP_MODEL


def bridge_port() -> int:
    port = int(os.getenv("TRADINGAGENTS_CODEX_PORT", "8766"))
    if not 1 <= port <= 65535:
        raise ValueError("TRADINGAGENTS_CODEX_PORT must be a port from 1 to 65535.")
    return port


def bridge_url() -> str:
    return f"http://{HOST}:{bridge_port()}/v1"


def bridge_timeout() -> float:
    timeout = float(os.getenv("TRADINGAGENTS_CODEX_TIMEOUT", "120"))
    if not isfinite(timeout) or timeout <= 0:
        raise ValueError("TRADINGAGENTS_CODEX_TIMEOUT must be a positive number of seconds.")
    return timeout
