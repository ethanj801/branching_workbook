"""Tests for the mock TabbyAPI-compatible completions endpoint.

These assertions pin down the wire format the real TabbyAPI proxy will later
replace: SSE framing with CRLF separators, JSON envelope with the expected
keys, `[DONE]` terminator, and a final chunk carrying `finish_reason`.
If any of these fail after the proxy swap in phase 4, that's the signal
the client expects something the real server isn't giving it.
"""

import json
import re

import pytest
from httpx import ASGITransport, AsyncClient

from bwbk import mock
from bwbk.main import app

FRAME_SEP = re.compile(r"\r?\n\r?\n")


def _parse_sse(body: str) -> tuple[list[dict], bool]:
    """Split a recorded SSE body into parsed JSON events + whether [DONE] was seen."""
    events: list[dict] = []
    done = False
    for frame in FRAME_SEP.split(body):
        if not frame:
            continue
        for line in frame.splitlines():
            if not line.startswith("data:"):
                continue
            payload = line[6:] if line.startswith("data: ") else line[5:]
            if payload == "[DONE]":
                done = True
                continue
            events.append(json.loads(payload))
    return events, done


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def reset_mock_model_state():
    mock.MOCK_MODELS[:] = [
        {
            "id": mock.MOCK_MODEL_ID,
            "object": "model",
            "created": 1,
            "owned_by": "tabbyAPI",
            "logging": None,
            "parameters": None,
        }
    ]
    mock.loaded_model = {
        "id": mock.MOCK_MODEL_ID,
        "object": "model",
        "created": 1,
        "owned_by": "tabbyAPI",
        "logging": None,
        "parameters": {
            "max_seq_len": 4096,
            "cache_size": 4096,
            "cache_mode": "Q6",
            "rope_scale": 1.0,
            "rope_alpha": 1.0,
            "max_batch_size": 256,
            "chunk_size": 2048,
            "prompt_template": None,
            "prompt_template_content": None,
            "use_vision": False,
            "draft": None,
        },
    }


async def test_health_returns_ok(client: AsyncClient):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_completions_streams_oai_shaped_chunks(client: AsyncClient):
    async with client.stream(
        "POST",
        "/api/completions",
        json={"prompt": "hello", "n": 1, "max_tokens": 40},
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        body = ""
        async for chunk in r.aiter_text():
            body += chunk

    events, done = _parse_sse(body)

    assert done, "stream must terminate with [DONE]"
    assert len(events) >= 2, "expected at least one content chunk + one finish chunk"

    for ev in events:
        assert set(ev) >= {"id", "object", "created", "model", "choices"}
        assert ev["object"] == "text_completion"
        assert ev["id"].startswith("cmpl-")
        assert len(ev["choices"]) == 1
        choice = ev["choices"][0]
        assert set(choice) >= {"index", "text", "finish_reason"}
        assert choice["index"] == 0


async def test_completions_emits_terminal_finish_reason(client: AsyncClient):
    async with client.stream(
        "POST",
        "/api/completions",
        json={"prompt": "hello", "n": 1, "max_tokens": 40},
    ) as r:
        body = ""
        async for chunk in r.aiter_text():
            body += chunk

    events, _ = _parse_sse(body)

    # All but the last event should have finish_reason=None
    for ev in events[:-1]:
        assert ev["choices"][0]["finish_reason"] is None

    final = events[-1]["choices"][0]
    assert final["finish_reason"] in ("stop", "length")
    assert final["text"] == ""


async def test_completions_assembles_into_continuous_text(client: AsyncClient):
    """Concatenating all choices[0].text across chunks must reconstruct a valid
    continuation — this is the invariant the client relies on when streaming
    deltas into a branch panel."""
    async with client.stream(
        "POST",
        "/api/completions",
        json={"prompt": "hello", "n": 1, "max_tokens": 200},
    ) as r:
        body = ""
        async for chunk in r.aiter_text():
            body += chunk

    events, _ = _parse_sse(body)
    text = "".join(ev["choices"][0]["text"] for ev in events)
    assert len(text) > 10
    # Mock canned text always starts with a space (continuation-style)
    assert text.startswith(" ")


async def test_completions_streams_interleaved_fanout_indexes(client: AsyncClient):
    async with client.stream(
        "POST",
        "/api/completions",
        json={"prompt": "hello", "n": 3, "max_tokens": 40},
    ) as r:
        body = ""
        async for chunk in r.aiter_text():
            body += chunk

    events, done = _parse_sse(body)
    assert done

    by_index = {0: "", 1: "", 2: ""}
    final_indexes: set[int] = set()
    for ev in events:
        choice = ev["choices"][0]
        assert choice["index"] in by_index
        by_index[choice["index"]] += choice["text"]
        if choice["finish_reason"] is not None:
            final_indexes.add(choice["index"])

    assert set(by_index) == final_indexes
    assert all(text.startswith(" ") for text in by_index.values())
    assert all(len(text) > 10 for text in by_index.values())


async def test_completions_respects_max_tokens_budget(client: AsyncClient):
    """max_tokens caps how much is streamed — approximated as max_tokens*4 chars."""
    small = 10
    async with client.stream(
        "POST",
        "/api/completions",
        json={"prompt": "hello", "n": 1, "max_tokens": small},
    ) as r:
        body = ""
        async for chunk in r.aiter_text():
            body += chunk

    events, _ = _parse_sse(body)
    text = "".join(ev["choices"][0]["text"] for ev in events)
    # Rough ceiling: max_tokens * 4 chars + one chunk's worth of slack (~8 chars)
    assert len(text) <= small * 4 + 10


async def test_model_endpoints_report_loaded_model(client: AsyncClient):
    current = (await client.get("/api/tabby/model")).json()
    assert current["id"] == mock.MOCK_MODEL_ID
    assert current["parameters"]["max_seq_len"] == 4096

    models = (await client.get("/api/tabby/models")).json()
    assert models["object"] == "list"
    assert [model["id"] for model in models["data"]] == [mock.MOCK_MODEL_ID]


async def test_model_load_stream_updates_current_model(client: AsyncClient):
    async with client.stream(
        "POST",
        "/api/tabby/model/load",
        json={"model_name": "other-model", "max_seq_len": 8192, "cache_mode": "Q8"},
    ) as r:
        assert r.status_code == 200
        body = ""
        async for chunk in r.aiter_text():
            body += chunk

    events, done = _parse_sse(body)
    assert done is False
    assert events[-1]["status"] == "finished"

    current = (await client.get("/api/tabby/model")).json()
    assert current["id"] == "other-model"
    assert current["parameters"]["max_seq_len"] == 8192
    assert current["parameters"]["cache_mode"] == "Q8"


async def test_unload_clears_current_model(client: AsyncClient):
    r = await client.post("/api/tabby/model/unload")

    assert r.status_code == 200
    assert r.json() == {"unloaded": True}
    assert (await client.get("/api/tabby/model")).json() is None


async def test_download_adds_model_to_mock_list(client: AsyncClient):
    r = await client.post(
        "/api/tabby/download",
        json={"repo_id": "lucyknada/google_gemma-3-270m-exl3", "revision": "6.0bpw"},
    )

    assert r.status_code == 200
    assert r.json()["download_path"] == "/mock-models/google_gemma-3-270m-exl3"
    models = (await client.get("/api/tabby/models")).json()["data"]
    assert "google_gemma-3-270m-exl3" in [model["id"] for model in models]


async def test_token_encode_returns_length(client: AsyncClient):
    r = await client.post("/api/tabby/token/encode", json={"text": "one two three"})

    assert r.status_code == 200
    payload = r.json()
    assert payload["length"] == 4
    assert len(payload["tokens"]) == 4
