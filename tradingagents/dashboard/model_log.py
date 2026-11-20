"""Record visible provider output and usage as a live, private run trace."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from time import monotonic

from langchain_core.callbacks import BaseCallbackHandler

from tradingagents.diagnostics import Redactor, elapsed_ms, event, exception_fields, trace_context

MODEL_LOG = "model_log.jsonl"
_FLUSH_INTERVAL = 0.15
_READ_LIMIT = 256
_PENDING_LIMIT = 1024
logger = logging.getLogger(__name__)


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
                elif kind == "thinking" and isinstance(thinking := block.get("thinking"), str):
                    yield "summary", thinking
                elif kind == "reasoning":
                    if isinstance(reasoning := block.get("reasoning"), str):
                        yield "summary", reasoning
                    if isinstance(summary := block.get("summary"), list):
                        for part in summary:
                            if isinstance(part, dict) and isinstance(text := part.get("text"), str):
                                yield "summary", text
    for field, channel in (("sarvam_reasoning", "reasoning"), ("reasoning_content", "reasoning"),
                           ("codex_reasoning_summary", "summary")):
        if isinstance(part := message.additional_kwargs.get(field), str) and part:
            yield channel, part


def _agent_name(metadata):
    # The leaf of a nested analyst graph is named "agent"; its parent has
    # the human-readable analyst name.
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


def _repair_tail(stream):
    end = stream.seek(0, os.SEEK_END)
    while end:
        start = max(0, end - 8192)
        stream.seek(start)
        block = stream.read(end - start)
        newline = block.rfind(b"\n")
        if newline >= 0:
            return stream.truncate(start + newline + 1)
        end = start
    return stream.truncate(0)


class ModelLog(BaseCallbackHandler):
    """One listener per job, shared by its tiers and parallel analysts."""

    def __init__(self, path: Path, providers: dict):
        self.path = path
        self.providers = {tier["model"]: tier["provider"] for tier in providers.values()}
        self.context = trace_context()
        self.redactor = Redactor()
        self.lock = Lock()
        self.pending: list[dict] = []
        self.last_flush = 0.0
        self.calls: dict[str, dict] = {}
        self.tools: dict[str, tuple[str, float]] = {}
        self.cell = None
        self._ready = False
        self._rollback = None
        self._write_failed = False
        self._dropped = 0

    def _flush(self, *, durable=False):
        if not self.pending:
            return
        self.last_flush = monotonic()
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
            with os.fdopen(descriptor, "r+b") as stream:
                if not self._ready:
                    os.chmod(self.path, 0o600)
                    _repair_tail(stream)
                    self._ready = True
                if self._rollback is not None:
                    stream.truncate(self._rollback)
                self._rollback = stream.seek(0, os.SEEK_END)
                records = self.pending
                if self._dropped:
                    records = [*records, {"type": "gap", "at": datetime.now(UTC).isoformat(),
                                          "dropped": self._dropped}]
                lines = "".join(json.dumps(record, ensure_ascii=False, default=str, allow_nan=False) + "\n"
                                for record in records)
                stream.write(lines.encode())
                stream.flush()
                if durable:
                    os.fsync(stream.fileno())
            self._rollback = None
            self.pending.clear()
            if self._write_failed:
                event(logger, "model.log_recovered", "Model trace storage recovered", dropped=self._dropped, **self.context)
            self._write_failed, self._dropped = False, 0
        except (OSError, TypeError, ValueError) as exc:
            if not self._write_failed:
                event(logger, "model.log_write_failed", "Could not write the per-run model trace",
                      level=logging.ERROR, **self.context, **exception_fields(exc))
            self._write_failed = True

    def _event(self, event_type, call_id, *, immediate=False, **values):
        at = datetime.now(UTC).isoformat(timespec="milliseconds")
        link = {key: self.context[key] for key in ("run_id", "scan_id") if key in self.context}
        self.pending.append({"type": event_type, "call": call_id, "at": at, **link, **values})
        if len(self.pending) > _PENDING_LIMIT:
            self.pending.pop(0)
            self._dropped += 1
        if immediate or monotonic() - self.last_flush >= _FLUSH_INTERVAL:
            self._flush(durable=immediate)

    def _record(self, name, message, call, *, level=logging.INFO, **fields):
        state = self.calls.get(call, {})
        details = {**self.context, "call_id": call, **state.get("model_info", {}), **fields}
        event(logger, name, message, level=level, **details)

    def on_chat_model_start(self, _serialized, _messages, *, run_id, metadata=None, **kwargs):
        meta = metadata or {}
        model = meta.get("ls_model_name") or kwargs.get("invocation_params", {}).get("model")
        call = str(run_id)
        with self.lock:
            model_info = self.redactor.value({
                "agent": _agent_name(meta), "model": model,
                "provider": self.providers.get(model) or meta.get("ls_provider"),
                "cell": self.cell, "parent_call_id": str(kwargs["parent_run_id"]) if kwargs.get("parent_run_id") else None,
            })
            self.calls[call] = {"model_info": model_info, "started": monotonic(), "text": {}}
            self._event("start", call, immediate=True, **model_info)
            self._record("model.started", "Model call started", call)

    def _delta(self, call, content, channel):
        buffers = self.calls[call]["text"]
        safe, buffers[channel] = self.redactor.stream(buffers.get(channel, "") + content)
        if safe:
            self._event("delta", call, channel=channel, text=safe)

    def _flush_text(self, call):
        for channel, pending in self.calls.get(call, {}).get("text", {}).items():
            if pending:
                self._event("delta", call, channel=channel, text=self.redactor.text(pending))

    def on_llm_new_token(self, token, *, run_id, chunk=None, **kwargs):
        message = getattr(chunk, "message", None)
        parts = _output_parts(message) if message is not None else [("text", token)]
        call = str(run_id)
        with self.lock:
            if call in self.calls:
                for channel, content in parts:
                    if isinstance(content, str) and content:
                        self._delta(call, content, channel)

    def on_llm_end(self, response, *, run_id, **kwargs):
        generations = response.generations
        generation = generations[0][0] if generations and generations[0] else None
        message = getattr(generation, "message", None)
        call = str(run_id)
        with self.lock:
            state = self.calls.get(call, {})
            channels = set(state.get("text", {}))
            self._flush_text(call)
            usage, tools, reason = None, [], None
            if message is not None:
                for channel, content in _output_parts(message):
                    if content and channel not in state.get("text", {}):
                        self._event("delta", call, channel=channel, text=self.redactor.text(content))
                        channels.add(channel)
                usage = _usage(message)
                tools = [{"name": tool["name"], "arguments": tool["args"]} for tool in message.tool_calls]
                reason = message.response_metadata.get("finish_reason")
            fields = self.redactor.value({"usage": usage, "reason": reason, "output_channels": sorted(channels),
                                          "elapsed_ms": elapsed_ms(state["started"]) if state else None})
            self._event("finish", call, immediate=True, tools=self.redactor.value(tools), **fields)
            self._record("model.completed", "Model call completed", call, tool_count=len(tools), **fields)
            self.calls.pop(call, None)

    def on_llm_error(self, error, *, run_id, **kwargs):
        call = str(run_id)
        with self.lock:
            self._flush_text(call)
            state = self.calls.get(call, {})
            fields = self.redactor.value(exception_fields(error, stack=True))
            duration = elapsed_ms(state["started"]) if state else None
            self._event("error", call, immediate=True, error=fields["error_type"],
                        detail=fields["error"], http_status=fields.get("status"), elapsed_ms=duration)
            self._record("model.failed", "Model call failed", call, level=logging.ERROR, elapsed_ms=duration, **fields)
            self.calls.pop(call, None)

    def on_retry(self, retry_state, *, run_id, **kwargs):
        call = str(run_id)
        with self.lock:
            self._record("model.retrying", "Retrying a model request", call, level=logging.WARNING,
                         attempt=retry_state.attempt_number,
                         wait_seconds=getattr(retry_state.next_action, "sleep", None))

    def on_tool_start(self, serialized, _input, *, run_id, **kwargs):
        call = str(run_id)
        with self.lock:
            name = (serialized or {}).get("name") or kwargs.get("name") or "Tool"
            self.tools[call] = (name, monotonic())
            event(logger, "tool.started", "Research tool started", tool=name, call_id=call,
                  cell=self.cell, **self.context)

    def _tool_finished(self, run_id, error=None):
        call = str(run_id)
        with self.lock:
            name, started = self.tools.pop(call, ("Tool", monotonic()))
            event(logger, "tool.failed" if error else "tool.completed",
                  "Research tool failed" if error else "Research tool completed",
                  level=logging.ERROR if error else logging.INFO, tool=name, call_id=call,
                  elapsed_ms=elapsed_ms(started), cell=self.cell,
                  **self.context, **(exception_fields(error, stack=True) if error else {}))

    def on_tool_end(self, _output, *, run_id, **kwargs):
        self._tool_finished(run_id)

    def on_tool_error(self, error, *, run_id, **kwargs):
        self._tool_finished(run_id, error)

    def record_tool_result(self, message):
        with self.lock:
            values = self.redactor.value({"name": message.name, "status": message.status})
            self._event("tool", str(message.tool_call_id), immediate=True, **values)
            event(logger, "tool.result", "Research tool returned a result",
                  level=logging.WARNING if message.status == "error" else logging.INFO,
                  tool_call_id=str(message.tool_call_id), **self.context, **values)

    def select_cell(self, ticker, day):
        with self.lock:
            self.cell = {"symbol": ticker, "date": day}

    def flush(self):
        with self.lock:
            self._flush(durable=True)


def _visible_record(line, redactor):
    try:
        record = json.loads(line)
    except (ValueError, UnicodeError):
        return {"type": "gap", "detail": "A damaged log record was skipped."}
    if not isinstance(record, dict):
        return {"type": "gap", "detail": "A damaged log record was skipped."}
    cleaned = redactor.value({key: value for key, value in record.items() if key != "text"})
    if isinstance(record.get("text"), str):
        cleaned["text"] = redactor.text(record["text"])
    return cleaned


def read_model_log(path: Path, offset: int) -> dict:
    """Read complete lines only. The writer may still be appending a batch."""
    events = []
    redactor = Redactor()
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
                events.append(_visible_record(line, redactor))
                offset = stream.tell()
    except FileNotFoundError:
        return {"events": [], "offset": 0, "more": False}
    return {"events": events, "offset": offset, "more": len(events) == _READ_LIMIT}


def model_log_lines(path: Path):
    """Yield redacted complete records from a fixed snapshot of a live file."""
    redactor = Redactor()
    with path.open("rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        while stream.tell() < size:
            line = stream.readline(size - stream.tell())
            if not line.endswith(b"\n"):
                break
            yield json.dumps(_visible_record(line, redactor), ensure_ascii=False) + "\n"
