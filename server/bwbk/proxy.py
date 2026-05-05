"""Thin proxy to TabbyAPI's OpenAI-compatible and model-control endpoints."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()

DEFAULT_TABBY_BASE_URL = "http://127.0.0.1:5000"
DEFAULT_TABBY_COMPLETIONS_URL = "http://127.0.0.1:5000/v1/completions"
DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS = 60.0


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


def _tabby_stream_read_timeout_seconds() -> float:
    raw = os.getenv("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS")
    if raw is None:
        return DEFAULT_TABBY_STREAM_READ_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError as ex:
        raise RuntimeError("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS must be a number") from ex
    if value <= 0:
        raise RuntimeError("BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS must be greater than zero")
    return value


def _tabby_stream_timeout() -> httpx.Timeout:
    read_timeout = _tabby_stream_read_timeout_seconds()
    return httpx.Timeout(
        connect=10.0,
        read=read_timeout,
        write=30.0,
        pool=10.0,
    )


def _sse_error_frame(message: str) -> bytes:
    return f"data: {json.dumps({'error': message})}\n\n".encode()


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
    read_timeout = _tabby_stream_read_timeout_seconds()
    client = httpx.AsyncClient(timeout=_tabby_stream_timeout())
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
    except httpx.TimeoutException as ex:
        await client.aclose()
        raise HTTPException(
            status_code=504,
            detail=f"TabbyAPI stream timed out after {read_timeout:g}s without a response",
        ) from ex
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
            try:
                async for chunk in upstream.aiter_bytes():
                    if await request.is_disconnected():
                        break
                    yield chunk
            except httpx.TimeoutException:
                yield _sse_error_frame(
                    f"TabbyAPI stream timed out after {read_timeout:g}s without data"
                )
            except httpx.HTTPError as ex:
                yield _sse_error_frame(f"TabbyAPI stream failed: {ex}")
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


@router.post("/api/chat/completions")
async def chat_completions(request: Request, body: dict[str, Any]):
    payload = {**body, "stream": True}
    return await _stream_tabby_post("/v1/chat/completions", request, payload)


@router.get("/api/tabby/model")
async def current_model():
    return await _request_json("GET", "/v1/model", missing_as_null=True)


@router.get("/api/tabby/models")
async def list_models():
    return await _request_json("GET", "/v1/models")


@router.post("/api/tabby/model/load")
async def load_model(request: Request, body: dict[str, Any]):
    return await _stream_tabby_post("/v1/model/load", request, body)


async def _model_is_unloaded() -> bool:
    try:
        current = await _request_json("GET", "/v1/model", missing_as_null=True)
    except HTTPException:
        return False
    return not current


@router.post("/api/tabby/model/unload")
async def unload_model():
    # TabbyAPI's /v1/model/unload races with exllamav3's AsyncGenerator: when an
    # unload lands just as a job reaches EOS, exllamav3 has already removed the
    # job from its internal `jobs` dict but TabbyAPI's `active_job_ids` still
    # holds it, so wait_for_jobs(skip_wait=True) calls cancel() and trips an
    # `assert job.job in self.jobs` in async_generator.py. The unload bubbles
    # up as 500/502 even though most of the teardown has already happened.
    # Recover by checking state and retrying once before surfacing the error.
    try:
        await _request_json("POST", "/v1/model/unload")
        return JSONResponse({"unloaded": True})
    except HTTPException as initial_error:
        if await _model_is_unloaded():
            return JSONResponse({"unloaded": True})
        await asyncio.sleep(0.1)
        try:
            await _request_json("POST", "/v1/model/unload")
            return JSONResponse({"unloaded": True})
        except HTTPException:
            if await _model_is_unloaded():
                return JSONResponse({"unloaded": True})
            raise initial_error from None


@router.post("/api/tabby/download")
async def download_model(body: dict[str, Any]):
    return await _request_json("POST", "/v1/download", body=body)


@router.post("/api/tabby/token/encode")
async def encode_tokens(body: dict[str, Any]):
    return await _request_json("POST", "/v1/token/encode", body=body)
