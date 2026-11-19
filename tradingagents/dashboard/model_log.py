"""Append the provider's visible output and usage to a per-job event log."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from time import monotonic

from langchain_core.callbacks import BaseCallbackHandler

MODEL_LOG = "model_log.jsonl"
_FLUSH_INTERVAL = 0.15
_READ_LIMIT = 256


def _output_parts(message):
    content = message.content
    if isinstance(content, str):
        if content:
            yield "text", content
    else:
        for block in content:
            if isinstance(block, str):
                yield "text", block
            elif isinstance(block, dict):
                kind = block.get("type")
                if kind == "text" and isinstance(text := block.get("text"), str):
                    yield "text", text
                elif kind == "thinking" and isinstance(summary := block.get("thinking"), str) or kind == "reasoning" and isinstance(summary := block.get("reasoning"), str):
                    yield "summary", summary
    trace = message.additional_kwargs.get("sarvam_reasoning")
    if isinstance(trace, str) and trace:
        yield "reasoning", trace
    summary = message.additional_kwargs.get("codex_reasoning_summary")
    if isinstance(summary, str) and summary:
        yield "summary", summary


def _agent_name(metadata):
    # In the analyst subgraphs the leaf is named "agent"; the parent is the
    # actual analyst. Top-level model calls already carry the graph node name.
    if namespace := metadata.get("langgraph_checkpoint_ns"):
        return namespace.split("|", 1)[0].split(":", 1)[0]
    return metadata.get("langgraph_node") or "Model call"


def _usage(message):
    usage = message.usage_metadata or {}
    if not usage:
        return None
    return {
        "input": usage.get("input_tokens"),
        "output": usage.get("output_tokens"),
        "thinking": (usage.get("output_token_details") or {}).get("reasoning"),
    }


class ModelLog(BaseCallbackHandler):
    """One listener per job, shared by its two tiers and parallel analysts."""

    def __init__(self, path: Path, providers: dict):
        self.path = path
        self.providers = {tier["model"]: tier["provider"] for tier in providers.values()}
        self.lock = Lock()
        self.pending: list[dict] = []
        self.last_flush = 0.0
        self.channels: dict[str, set[str]] = {}
        self.cell = None

    def _flush(self):
        if not self.pending:
            return
        lines = "".join(json.dumps(event, ensure_ascii=False, default=str) + "\n" for event in self.pending)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(lines)
        self.pending.clear()
        self.last_flush = monotonic()

    def _event(self, event_type, call_id, *, immediate=False, **values):
        at = datetime.now(UTC).isoformat(timespec="milliseconds")
        self.pending.append({"type": event_type, "call": call_id, "at": at, **values})
        if immediate or monotonic() - self.last_flush >= _FLUSH_INTERVAL:
            self._flush()

    def on_chat_model_start(self, _serialized, _messages, *, run_id, metadata=None, **kwargs):
        meta = metadata or {}
        model = meta.get("ls_model_name") or kwargs.get("invocation_params", {}).get("model")
        call = str(run_id)
        with self.lock:
            self.channels[call] = set()
            self._event(
                "start", call, immediate=True,
                agent=_agent_name(meta), model=model,
                provider=self.providers.get(model) or meta.get("ls_provider"),
                cell=self.cell,
            )

    def on_llm_new_token(self, token, *, run_id, chunk=None, **kwargs):
        message = getattr(chunk, "message", None)
        parts = _output_parts(message) if message is not None else [("text", token)]
        with self.lock:
            call = str(run_id)
            if call not in self.channels:
                return
            for channel, content in parts:
                if isinstance(content, str) and content:
                    self.channels[call].add(channel)
                    self._event("delta", call, channel=channel, text=content)

    def on_llm_end(self, response, *, run_id, **kwargs):
        generations = response.generations
        generation = generations[0][0] if generations and generations[0] else None
        message = getattr(generation, "message", None)
        call = str(run_id)
        with self.lock:
            streamed = self.channels.pop(call, set())
            usage, tools, reason = None, [], None
            if message is not None:
                for channel, content in _output_parts(message):
                    if content and channel not in streamed:
                        self._event("delta", call, channel=channel, text=content)
                usage = _usage(message)
                tools = [{"name": tool["name"], "arguments": tool["args"]} for tool in message.tool_calls]
                reason = message.response_metadata.get("finish_reason")
            self._event("finish", call, immediate=True, usage=usage, tools=tools, reason=reason)

    def on_llm_error(self, error, *, run_id, **kwargs):
        call = str(run_id)
        with self.lock:
            self.channels.pop(call, None)
            self._event("error", call, immediate=True, error=type(error).__name__,
                        http_status=getattr(error, "status_code", None))

    def record_tool_result(self, message):
        # Tool outputs can include long tables or articles. The model log
        # records their arrival and status while the report supplies evidence.
        with self.lock:
            self._event("tool", str(message.tool_call_id), immediate=True, name=message.name,
                        status=message.status)

    def select_cell(self, ticker, day):
        with self.lock:
            self.cell = {"symbol": ticker, "date": day}


def read_model_log(path: Path, offset: int) -> dict:
    """Read complete lines only. The writer may still be appending a batch."""
    events = []
    try:
        with path.open("rb") as stream:
            if offset:
                stream.seek(offset - 1)
                if stream.read(1) != b"\n":
                    raise ValueError("Use the offset returned by the model log endpoint.")
            stream.seek(offset)
            for _ in range(_READ_LIMIT):
                line = stream.readline()
                if not line.endswith(b"\n"):
                    break
                events.append(json.loads(line))
                offset = stream.tell()
    except FileNotFoundError:
        return {"events": [], "offset": 0, "more": False}
    return {"events": events, "offset": offset, "more": len(events) == _READ_LIMIT}
