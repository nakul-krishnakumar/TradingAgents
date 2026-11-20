import asyncio
import json
import logging
import secrets
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from openai import OpenAI
from pydantic import BaseModel

from tradingagents.dashboard.codex_bridge import ChatRequest, CodexExec, create_app
from tradingagents.dashboard.model_log import ModelLog, read_model_log
from tradingagents.diagnostics import EventHandler, diagnostic_context, read_events
from tradingagents.llm_clients.codex_config import (
    DEFAULT_DEEP_MODEL,
    DEFAULT_MODEL,
    KEY_ENV,
    bridge_models,
)
from tradingagents.llm_clients.factory import create_tier_client


@pytest.mark.parametrize("model", ("gpt-6.2-sol", "gpt-6.2-astra"))
def test_codex_exec_uses_selected_model_with_max_ultrafast(monkeypatch, model):
    for name in ("MODEL", "MODELS", "REASONING_EFFORT", "SERVICE_TIER"):
        monkeypatch.delenv(f"TRADINGAGENTS_CODEX_{name}", raising=False)
    backend = CodexExec()
    assert backend.models == ("gpt-6.2-sol", "gpt-6.2-astra")

    async def check_command(command, _folder, _prompt, _summaries):
        assert command[command.index("--model") + 1] == model
        assert 'model_reasoning_effort="max"' in command
        assert 'service_tier="ultrafast"' in command
        return "READY", {}

    monkeypatch.setattr(backend, "_run", check_command)
    chat = ChatRequest(model=model, messages=[{"role": "user", "content": "Say READY"}])
    assert asyncio.run(backend.generate(chat, "Say READY", None, None)) == ("READY", {})


def test_bridge_models_accepts_existing_single_model_configuration(monkeypatch):
    monkeypatch.delenv("TRADINGAGENTS_CODEX_MODELS", raising=False)
    monkeypatch.setenv("TRADINGAGENTS_CODEX_MODEL", "gpt-6.2-sol")
    assert bridge_models() == ("gpt-6.2-sol",)

    monkeypatch.setenv("TRADINGAGENTS_CODEX_MODELS", "gpt-6.2-astra, gpt-6.2-sol, gpt-6.2-sol")
    assert bridge_models() == ("gpt-6.2-astra", "gpt-6.2-sol")


@pytest.fixture
def bridge():
    class Backend:
        models = (DEFAULT_MODEL, DEFAULT_DEEP_MODEL)
        key = secrets.token_urlsafe(32)
        binary = "stub"
        slots = asyncio.Semaphore(1)

        async def generate(self, chat, prompt, schema, summaries):
            if summaries is not None:
                summaries.put_nowait("Considered the supplied price evidence.")
            if chat.tools:
                assert schema["properties"]["calls"]["items"]["properties"]["name"]["enum"] == ["get_quote"]
                if any(message["role"] == "tool" for message in chat.messages):
                    assert '"tool_call_id"' in prompt
                    answer = {"content": "The quoted price was 42.", "calls": []}
                else:
                    answer = {"content": "", "calls": [{"name": "get_quote", "arguments": '{"symbol":"TEST"}'}]}
                text = json.dumps(answer)
            elif chat.response_format:
                assert "value" in schema["properties"]
                text = '{"value":42}'
            else:
                text = "READY"
            return text, {"input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 12, "reasoning_output_tokens": 4}

    backend = Backend()
    with TestClient(create_app(backend), base_url="http://127.0.0.1:8766") as http:
        yield backend, http


def test_openai_client_tool_call_and_result(bridge):
    backend, http = bridge
    model = backend.models[0]
    client = OpenAI(api_key=backend.key, base_url="http://127.0.0.1:8766/v1", http_client=http)
    assert http.get("/v1/models").status_code == 401
    assert tuple(entry.id for entry in client.models.list()) == backend.models
    assert http.get("/health", headers={"Authorization": f"Bearer {backend.key}"}).json()["models"] == list(backend.models)
    tools = [{"type": "function", "function": {"name": "get_quote", "description": "Get a sample quote."}}]
    messages = [{"role": "user", "content": "Get the price for TEST."}]
    assert http.post("/v1/chat/completions", headers={"Authorization": f"Bearer {backend.key}"},
                     json={"model": "unconfigured", "messages": messages}).status_code == 404
    with client.chat.completions.create(model=model, messages=messages, tools=tools,
                                        tool_choice="required", stream=True, stream_options={"include_usage": True}) as stream:
        chunks = list(stream)
    assert all(chunk.model == model for chunk in chunks)
    call = next(chunk.choices[0].delta.tool_calls[0] for chunk in chunks
                if chunk.choices and chunk.choices[0].delta.tool_calls)
    assert call.function.name == "get_quote"
    assert json.loads(call.function.arguments) == {"symbol": "TEST"}
    assert chunks[-2].choices[0].finish_reason == "tool_calls"
    assert chunks[-1].usage.prompt_tokens_details.cached_tokens == 80
    messages.extend([
        {"role": "assistant", "tool_calls": [{"id": call.id, "type": "function", "function": call.function.model_dump()}]},
        {"role": "tool", "tool_call_id": call.id, "content": "42"},
    ])
    answer = client.chat.completions.create(model=model, messages=messages, tools=tools)
    assert answer.choices[0].message.content == "The quoted price was 42."


def test_codex_provider_usage_and_summary_reach_model_log(bridge, monkeypatch, tmp_path: Path):
    backend, http = bridge
    quick, deep = backend.models
    monkeypatch.setenv(KEY_ENV, backend.key)
    monkeypatch.setenv("OPENAI_COMPATIBLE_API_KEY", secrets.token_urlsafe(32))
    config = {"llm_provider": "codex", "quick_think_llm": quick, "deep_think_llm": deep,
              "stream_model_output": True}
    quick_client = create_tier_client(config, "quick", http_client=http).get_llm()
    deep_client = create_tier_client(config, "deep", http_client=http).get_llm()
    path = tmp_path / "model_log.jsonl"
    callback = ModelLog(path, {"quick": {"provider": "OpenAI Codex", "model": quick},
                               "deep": {"provider": "OpenAI Codex", "model": deep}})

    result = quick_client.invoke("Say READY", config={"callbacks": [callback]})

    assert result.content == "READY"
    events = read_model_log(path, 0)["events"]
    assert any(event.get("channel") == "summary" and event["text"] == "Considered the supplied price evidence." for event in events)
    assert events[-1]["usage"] == {"input": 100, "output": 12, "thinking": 4}

    class Result(BaseModel):
        value: int

    structured = deep_client.with_structured_output(Result).invoke("Return 42", config={"callbacks": [callback]})

    assert structured.value == 42
    events = read_model_log(path, 0)["events"]
    assert [event["model"] for event in events if event["type"] == "start"] == [quick, deep]
    assert events[-1]["usage"] == {"input": 100, "output": 12, "thinking": 4}



def test_bridge_call_can_be_followed_by_original_run_and_model_call_ids(bridge, monkeypatch, tmp_path):
    backend, http = bridge
    monkeypatch.setenv(KEY_ENV, backend.key)
    config = {"llm_provider": "codex", "quick_think_llm": backend.models[0], "stream_model_output": True}
    client = create_tier_client(config, "quick", http_client=http).get_llm()
    logger = logging.getLogger("tradingagents.dashboard.codex_bridge")
    handler = EventHandler("codex-bridge", tmp_path / "events.sqlite3")
    old_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    run = uuid4().hex
    try:
        with diagnostic_context(run_id=run):
            trace = ModelLog(tmp_path / "model_log.jsonl", {})
            assert client.invoke("Say READY", config={"callbacks": [trace]}).content == "READY"
    finally:
        logger.removeHandler(handler)
        logger.setLevel(old_level)
        handler.close()
    call = read_model_log(trace.path, 0)["events"][0]["call"]
    events = read_events(handler.path, trace=run)["events"]
    assert any(entry["event"] == "codex.completed" and entry["fields"]["call_id"] == call for entry in events)
