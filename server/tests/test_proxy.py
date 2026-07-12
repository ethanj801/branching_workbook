import asyncio
import json

import httpx
import pytest

from bwbk.proxy import (
    DEFAULT_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS,
    DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS,
    _stream_tabby_post,
    _tabby_base_url,
    _tabby_headers,
    _tabby_stream_first_data_timeout_seconds,
    _tabby_stream_read_timeout_seconds,
    _tabby_stream_timeout,
    _tabby_url,
    chat_completions,
)


def test_tabby_headers_empty_without_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_API_KEY", raising=False)

    assert _tabby_headers() == {}


def test_tabby_headers_forwards_api_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_API_KEY", "secret")

    assert _tabby_headers() == {"x-api-key": "secret"}


def test_tabby_base_url_defaults_from_completions_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_BASE_URL", raising=False)
    monkeypatch.setenv(
        "BWBK_TABBY_COMPLETIONS_URL",
        "http://127.0.0.1:5001/v1/completions",
    )

    assert _tabby_base_url() == "http://127.0.0.1:5001"
    assert _tabby_url("/v1/model") == "http://127.0.0.1:5001/v1/model"
    assert (
        _tabby_url("http://127.0.0.1:9999/custom/completions")
        == "http://127.0.0.1:9999/custom/completions"
    )


def test_tabby_base_url_env_takes_precedence(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_BASE_URL", "http://127.0.0.1:5002/")
    monkeypatch.setenv(
        "BWBK_TABBY_COMPLETIONS_URL",
        "http://127.0.0.1:5001/v1/completions",
    )

    assert _tabby_base_url() == "http://127.0.0.1:5002"


def test_tabby_stream_timeout_defaults_to_60s(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", raising=False)

    assert _tabby_stream_read_timeout_seconds() == DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS


def test_tabby_stream_timeout_can_be_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "2.5")

    assert _tabby_stream_read_timeout_seconds() == 2.5


def test_tabby_stream_timeout_rejects_invalid_values(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "0")

    with pytest.raises(RuntimeError, match="greater than zero"):
        _tabby_stream_read_timeout_seconds()


def test_tabby_first_data_timeout_defaults_to_30min(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BWBK_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS", raising=False)

    assert (
        _tabby_stream_first_data_timeout_seconds()
        == DEFAULT_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS
    )


def test_tabby_first_data_timeout_can_be_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS", "120")

    assert _tabby_stream_first_data_timeout_seconds() == 120


def test_tabby_stream_leaves_httpx_reads_unbounded():
    # The two-phase deadline in _stream_tabby_post owns read timing;
    # a finite httpx read timeout would cut prefill short again.
    assert _tabby_stream_timeout().read is None


class _FakeRequest:
    async def is_disconnected(self) -> bool:
        return False


async def _collect_stream(response) -> list[bytes]:
    return [chunk async for chunk in response.body_iterator]


def _sse_transport(chunks: list[bytes], *, delay_before_first: float = 0.0):
    async def handler(request: httpx.Request) -> httpx.Response:
        async def body():
            if delay_before_first:
                await asyncio.sleep(delay_before_first)
            for chunk in chunks:
                yield chunk

        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_AsyncIteratorStream(body()),
        )

    return httpx.MockTransport(handler)


class _AsyncIteratorStream(httpx.AsyncByteStream):
    def __init__(self, iterator):
        self._iterator = iterator

    async def __aiter__(self):
        async for chunk in self._iterator:
            yield chunk


def test_stream_survives_a_prefill_longer_than_the_read_timeout(
    monkeypatch: pytest.MonkeyPatch,
):
    # First byte arrives after the read timeout would have fired.
    # The generous first-data budget must carry the wait instead.
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "0.05")
    monkeypatch.setenv("BWBK_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS", "5")
    transport = _sse_transport([b"data: one\n\n", b"data: two\n\n"], delay_before_first=0.2)
    monkeypatch.setattr(
        httpx.AsyncClient,
        "__init__",
        _patched_client_init(transport),
    )

    async def run():
        response = await _stream_tabby_post(
            "http://tabby.test/v1/completions", _FakeRequest(), {"prompt": "x"}
        )
        return await _collect_stream(response)

    chunks = asyncio.run(run())
    assert b"".join(chunks) == b"data: one\n\ndata: two\n\n"


def test_stream_reports_a_stall_after_data_started(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "0.05")
    monkeypatch.setenv("BWBK_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS", "5")

    async def handler(request: httpx.Request) -> httpx.Response:
        async def body():
            yield b"data: one\n\n"
            await asyncio.sleep(10)
            yield b"data: never\n\n"

        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_AsyncIteratorStream(body()),
        )

    monkeypatch.setattr(
        httpx.AsyncClient,
        "__init__",
        _patched_client_init(httpx.MockTransport(handler)),
    )

    async def run():
        response = await _stream_tabby_post(
            "http://tabby.test/v1/completions", _FakeRequest(), {"prompt": "x"}
        )
        return await _collect_stream(response)

    chunks = asyncio.run(run())
    assert chunks[0] == b"data: one\n\n"
    error = json.loads(chunks[-1].removeprefix(b"data: ").strip())
    assert "timed out after 0.05s" in error["error"]


def test_stream_reports_first_data_timeout_with_prefill_hint(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS", "5")
    monkeypatch.setenv("BWBK_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS", "0.05")
    transport = _sse_transport([b"data: late\n\n"], delay_before_first=10)
    monkeypatch.setattr(
        httpx.AsyncClient,
        "__init__",
        _patched_client_init(transport),
    )

    async def run():
        response = await _stream_tabby_post(
            "http://tabby.test/v1/completions", _FakeRequest(), {"prompt": "x"}
        )
        return await _collect_stream(response)

    chunks = asyncio.run(run())
    error = json.loads(chunks[-1].removeprefix(b"data: ").strip())
    assert "no data within 0.05s" in error["error"]
    assert "BWBK_TABBY_STREAM_FIRST_DATA_TIMEOUT_SECONDS" in error["error"]


def _patched_client_init(transport: httpx.MockTransport):
    original_init = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = transport
        original_init(self, *args, **kwargs)

    return patched


def test_chat_completions_forwards_continue_final_message(
    monkeypatch: pytest.MonkeyPatch,
):
    """The proxy passes the chat body through to TabbyAPI verbatim, so the
    continuation flag and the final assistant message reach the template
    layer untouched."""
    captured = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())

        async def body():
            yield b"data: [DONE]\n\n"

        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_AsyncIteratorStream(body()),
        )

    monkeypatch.setattr(
        httpx.AsyncClient,
        "__init__",
        _patched_client_init(httpx.MockTransport(handler)),
    )

    async def run():
        response = await chat_completions(
            _FakeRequest(),
            {
                "messages": [
                    {"role": "user", "content": "Tell me a story."},
                    {"role": "assistant", "content": "The story begins"},
                ],
                "continue_final_message": True,
                "add_generation_prompt": False,
            },
        )
        return await _collect_stream(response)

    asyncio.run(run())
    sent = captured["body"]
    assert sent["continue_final_message"] is True
    assert sent["add_generation_prompt"] is False
    assert sent["messages"][-1] == {"role": "assistant", "content": "The story begins"}
    assert sent["stream"] is True
