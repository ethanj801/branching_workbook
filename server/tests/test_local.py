"""Tests for the local backend's transport shaping.

A fake engine stands in for bwbk.engine.Engine so these run in the default test env with no
model download. They pin the wire shape the mock tests also pin (bwbk.local shares the SSE
envelope with bwbk.mock through bwbk.sse), plus what is specific to this backend: one branch
per n, and the diverse probe emitting top_logprobs in both the completion-map and chat-list
shapes. The engine's own batched decode is covered by an integration check against the real
model, not here.
"""

import json
import re

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from bwbk import local

FRAME_SEP = re.compile(r"\r?\n\r?\n")

_PROBE_TOKENS = [" The", " She", " There", " He", " It", " A", " They", " Rain"]
_STREAM_PIECES = [" Hello", " there", " world"]


def _parse_sse(body: str) -> tuple[list[dict], bool]:
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


class FakeEngine:
    """Stand-in for bwbk.engine.Engine covering what bwbk.local calls."""

    def tokenize(self, text: str, add_bos: bool = True, special: bool = True):
        ids = list(range(len(text.split())))
        return [0, *ids] if add_bos else ids

    def submit(self, specs, queue, loop):
        # Runs in the test's event loop, so push events straight onto the queue.
        for spec in specs:
            if spec.kind == "probe":
                top = {token: -(0.2 + 0.3 * i) for i, token in enumerate(_PROBE_TOKENS[: spec.k])}
                queue.put_nowait(
                    {
                        "kind": "probe",
                        "index": spec.index,
                        "top": top,
                        "token": _PROBE_TOKENS[0],
                        "logprob": -0.2,
                    }
                )
            else:
                for piece in _STREAM_PIECES:
                    queue.put_nowait({"kind": "token", "index": spec.index, "text": piece})
                queue.put_nowait({"kind": "finish", "index": spec.index, "reason": "stop"})


@pytest.fixture(autouse=True)
def fake_engine():
    prev = local._engine
    local._engine = FakeEngine()
    yield local._engine
    local._engine = prev


@pytest.fixture
async def client():
    app = FastAPI()
    app.include_router(local.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _post_stream(client: AsyncClient, path: str, payload: dict) -> str:
    body = ""
    async with client.stream("POST", path, json=payload) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        async for chunk in r.aiter_text():
            body += chunk
    return body


async def test_completions_stream_reconstruct_text(client: AsyncClient):
    body = await _post_stream(
        client, "/api/completions", {"prompt": "hello", "n": 1, "max_tokens": 40}
    )
    events, done = _parse_sse(body)

    assert done
    for ev in events:
        assert ev["id"].startswith("cmpl-")
        assert ev["object"] == "text_completion"
        assert set(ev["choices"][0]) >= {"index", "text", "finish_reason"}
    text = "".join(ev["choices"][0]["text"] for ev in events)
    assert text == "".join(_STREAM_PIECES)
    assert events[-1]["choices"][0]["finish_reason"] == "stop"


async def test_completions_fan_out_n_branches(client: AsyncClient):
    body = await _post_stream(
        client, "/api/completions", {"prompt": "hello", "n": 3, "max_tokens": 40}
    )
    events, done = _parse_sse(body)

    assert done
    finished = {
        ev["choices"][0]["index"] for ev in events if ev["choices"][0]["finish_reason"] is not None
    }
    assert finished == {0, 1, 2}


async def test_completion_probe_emits_top_logprobs(client: AsyncClient):
    body = await _post_stream(
        client,
        "/api/completions",
        {"prompt": "hello", "n": 1, "max_tokens": 1, "logprobs": 6, "top_logprobs": 6},
    )
    events, _ = _parse_sse(body)

    top = events[0]["choices"][0]["logprobs"]["top_logprobs"][0]
    assert isinstance(top, dict)
    assert len(top) == 6
    assert " The" in top


async def test_chat_probe_emits_content_top_logprobs(client: AsyncClient):
    body = await _post_stream(
        client,
        "/api/chat/completions",
        {
            "messages": [{"role": "user", "content": "hello"}],
            "n": 1,
            "max_tokens": 1,
            "logprobs": 6,
            "top_logprobs": 6,
        },
    )
    events, _ = _parse_sse(body)

    leaves = events[0]["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    assert isinstance(leaves, list)
    assert len(leaves) == 6
    assert set(leaves[0]) == {"token", "logprob"}


async def test_chat_streams_delta_chunks(client: AsyncClient):
    body = await _post_stream(
        client,
        "/api/chat/completions",
        {"messages": [{"role": "user", "content": "hello"}], "n": 1, "max_tokens": 40},
    )
    events, done = _parse_sse(body)

    assert done
    for ev in events:
        assert ev["id"].startswith("chatcmpl-")
        assert ev["model_name"] == local.MODEL_ID
        assert set(ev["choices"][0]) >= {"index", "delta", "finish_reason"}
    text = "".join(ev["choices"][0]["delta"].get("content", "") for ev in events)
    assert text == "".join(_STREAM_PIECES)


async def test_token_encode_uses_engine(client: AsyncClient):
    r = await client.post("/api/tabby/token/encode", json={"text": "one two three"})
    assert r.status_code == 200
    payload = r.json()
    assert payload["length"] == 4
    assert len(payload["tokens"]) == 4


async def test_current_model_reports_local_id(client: AsyncClient):
    r = await client.get("/api/tabby/model")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == local.MODEL_ID
    assert body["parameters"]["max_batch_size"] == local.MAX_SEQS
