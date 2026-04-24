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
