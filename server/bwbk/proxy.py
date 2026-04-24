"""Thin proxy to TabbyAPI's OpenAI-compatible and model-control endpoints."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()

DEFAULT_TABBY_BASE_URL = "http://127.0.0.1:5000"
DEFAULT_TABBY_COMPLETIONS_URL = "http://127.0.0.1:5000/v1/completions"


def _tabby_completions_url() -> str:
    return os.getenv("BWBK_TABBY_COMPLETIONS_URL", DEFAULT_TABBY_COMPLETIONS_URL)


def _tabby_base_url() -> str:
    explicit = os.getenv("BWBK_TABBY_BASE_URL")
    if explicit:
        return explicit.rstrip("/")

    completions_url = _tabby_completions_url()
    if completions_url.endswith("/v1/completions"):
        return completions_url[: -len("/v1/completions")].rstrip("/")

    split = urlsplit(completions_url)
    return urlunsplit((split.scheme, split.netloc, "", "", "")).rstrip("/")


def _tabby_url(path: str) -> str:
    if path.startswith(("http://", "https://")):
        return path
    return f"{_tabby_base_url()}{path}"


def _tabby_headers() -> dict[str, str]:
    api_key = os.getenv("BWBK_TABBY_API_KEY")
    if not api_key:
        return {}
    return {"x-api-key": api_key}


async def _read_error_detail(response: httpx.Response) -> str:
    text = (await response.aread()).decode("utf-8", errors="replace")
    return text or response.reason_phrase


async def _request_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    missing_as_null: bool = False,
) -> Any:
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            response = await client.request(
                method,
                _tabby_url(path),
                json=body,
                headers=_tabby_headers(),
            )
    except httpx.HTTPError as ex:
        raise HTTPException(status_code=502, detail=f"TabbyAPI request failed: {ex}") from ex

    if missing_as_null and response.status_code in {400, 404, 409, 422, 503}:
        return None

    if response.status_code >= 400:
        detail = await _read_error_detail(response)
        raise HTTPException(
            status_code=502,
            detail=f"TabbyAPI returned {response.status_code}: {detail}",
        )

    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError as ex:
        raise HTTPException(
            status_code=502,
            detail=f"TabbyAPI returned non-JSON response: {response.text}",
        ) from ex


async def _stream_tabby_post(path: str, request: Request, body: dict[str, Any]):
    client = httpx.AsyncClient(timeout=None)
    upstream: httpx.Response | None = None

    try:
        upstream = await client.send(
            client.build_request(
                "POST",
                _tabby_url(path),
                json=body,
                headers=_tabby_headers(),
            ),
            stream=True,
        )
    except httpx.HTTPError as ex:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"TabbyAPI request failed: {ex}") from ex

    if upstream.status_code >= 400:
        detail = await _read_error_detail(upstream)
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


@router.post("/api/completions")
async def completions(request: Request, body: dict[str, Any]):
    payload = {**body, "stream": True}
    return await _stream_tabby_post(_tabby_completions_url(), request, payload)


@router.get("/api/tabby/model")
async def current_model():
    return await _request_json("GET", "/v1/model", missing_as_null=True)


@router.get("/api/tabby/models")
async def list_models():
    return await _request_json("GET", "/v1/models")


@router.post("/api/tabby/model/load")
async def load_model(request: Request, body: dict[str, Any]):
    return await _stream_tabby_post("/v1/model/load", request, body)


@router.post("/api/tabby/model/unload")
async def unload_model():
    await _request_json("POST", "/v1/model/unload")
    return JSONResponse({"unloaded": True})


@router.post("/api/tabby/download")
async def download_model(body: dict[str, Any]):
    return await _request_json("POST", "/v1/download", body=body)


@router.post("/api/tabby/token/encode")
async def encode_tokens(body: dict[str, Any]):
    return await _request_json("POST", "/v1/token/encode", body=body)
