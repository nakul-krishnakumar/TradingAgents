import json
import logging
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, LLMResult

from tradingagents.dashboard.model_log import ModelLog, read_model_log
from tradingagents.llm_clients.openai_client import SarvamStreamingChatOpenAI


def test_streamed_text_and_usage_are_recorded_once(tmp_path):
    trace = ModelLog(tmp_path / "model_log.jsonl", {"quick": {"model": "gemini", "provider": "Google Gemini"}})
    run = uuid4()
    trace.on_chat_model_start({}, [], run_id=run, metadata={
        "ls_model_name": "gemini", "langgraph_checkpoint_ns": "Market Analyst:id|agent:id",
    })
    first = read_model_log(trace.path, 0)
    assert first["events"][0]["agent"] == "Market Analyst"
    assert first["events"][0]["provider"] == "Google Gemini"
    trace.on_llm_new_token(token="", run_id=run, chunk=ChatGenerationChunk(message=AIMessageChunk(
        content=[{"type": "thinking", "thinking": "A provider summary.", "signature": "private-signature"},
                 {"type": "text", "text": "₹100"}],
    )))
    trace.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(
        content="₹100", usage_metadata={
            "input_tokens": 7, "output_tokens": 13, "total_tokens": 20,
            "output_token_details": {"reasoning": 8},
        },
    ))]]), run_id=run)
    tail = read_model_log(trace.path, first["offset"])
    assert [(event.get("channel"), event.get("text")) for event in tail["events"][:-1]] == [
        ("summary", "A provider summary."), ("text", "₹100"),
    ]
    assert tail["events"][-1]["usage"] == {"input": 7, "output": 13, "thinking": 8}
    assert "private-signature" not in trace.path.read_text()
    assert read_model_log(trace.path, tail["offset"])["events"] == []


def test_model_log_cursor_can_follow_an_incomplete_append(tmp_path):
    path = tmp_path / "stream.jsonl"
    line = json.dumps({"type": "start"}) + "\n"
    path.write_text(line + '{"type": "fin')
    first = read_model_log(path, 0)
    assert first["events"] == [{"type": "start"}]
    assert first["offset"] == len(line)
    with path.open("a") as handle:
        handle.write('ish"}\n')
    assert read_model_log(path, first["offset"])["events"] == [{"type": "finish"}]
    with pytest.raises(ValueError, match="offset"):
        read_model_log(path, 1)


def test_model_log_recovers_after_write_failure_and_truncates_an_incomplete_record(tmp_path, monkeypatch, caplog):
    secret = "an intentionally split private credential"
    monkeypatch.setenv("TRADINGAGENTS_TUNNEL_PASSWORD", secret)
    parent = tmp_path / "blocked"
    parent.write_text("File where the model directory should be")
    trace = ModelLog(parent / "model_log.jsonl", {})
    run = uuid4()
    with caplog.at_level(logging.INFO):
        trace.on_chat_model_start({}, [], run_id=run)
        parent.unlink()
        parent.mkdir()
        trace.path.write_text('{"type":"tool"}\n{"type":"brok')
        trace.on_llm_new_token("The provider echoed " + secret[:17], run_id=run)
        trace.on_llm_new_token(secret[17:] + " in this test.", run_id=run)
        error = RuntimeError("Authorization: Bearer unknown-auth-credential")
        trace.on_llm_error(error, run_id=run)
    events = read_model_log(trace.path, 0)["events"]
    assert [entry["type"] for entry in events] == ["tool", "start", "delta", "error"]
    assert events[2]["text"] == "The provider echoed [REDACTED] in this test."
    assert events[3]["detail"] == "[REDACTED]"
    assert secret not in trace.path.read_text()
    assert any(getattr(record, "event_name", None) == "model.log_write_failed" for record in caplog.records)
    assert any(getattr(record, "event_name", None) == "model.log_recovered" for record in caplog.records)


def test_sarvam_stream_adapter_preserves_reasoning_and_usage():
    llm = SarvamStreamingChatOpenAI(model="test-model", api_key="test-key",
                                  base_url="https://api.sarvam.ai/v2", streaming=True)
    thought = llm._convert_chunk_to_generation_chunk(
        {"choices": [{"delta": {"role": "assistant", "reasoning_content": "Provider trace"}}]},
        AIMessageChunk, None,
    )
    final = llm._convert_chunk_to_generation_chunk(
        {"choices": [], "usage": {
            "prompt_tokens": 4, "completion_tokens": 12, "total_tokens": 16, "reasoning_tokens": 8,
        }},
        AIMessageChunk, None,
    )
    assert thought.message.additional_kwargs["sarvam_reasoning"] == "Provider trace"
    assert final.message.usage_metadata["output_token_details"]["reasoning"] == 8
