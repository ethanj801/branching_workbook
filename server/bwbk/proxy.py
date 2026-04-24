"""Thin streaming proxy to TabbyAPI's OpenAI-compatible completions endpoint."""

from __future__ import annotations

import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

DEFAULT_TABBY_COMPLETIONS_URL = "http://127.0.0.1:5000/v1/completions"


def _tabby_completions_url() -> str:
    return os.getenv("BWBK_TABBY_COMPLETIONS_URL", DEFAULT_TABBY_COMPLETIONS_URL)


@router.post("/api/completions")
async def completions(request: Request, body: dict[str, Any]):
    payload = {**body, "stream": True}
    client = httpx.AsyncClient(timeout=None)
    upstream: httpx.Response | None = None

    try:
        upstream = await client.send(
            client.build_request("POST", _tabby_completions_url(), json=payload),
            stream=True,
        )
    except httpx.HTTPError as ex:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"TabbyAPI request failed: {ex}") from ex

    if upstream.status_code >= 400:
        detail = (await upstream.aread()).decode("utf-8", errors="replace")
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(
            status_code=502,
            detail=f"TabbyAPI returned {upstream.status_code}: {detail}",
        )

    async def stream_upstream():
        try:
            async for chunk in upstream.aiter_bytes():
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_upstream(),
        media_type=upstream.headers.get("content-type", "text/event-stream"),
    )
