"""
Local lightweight-LLM backend.

Runs a tiny GGUF model in-process through the continuous-batching engine (bwbk.engine) so
the client's features, above all "Diverse openings", can be exercised locally with real,
prompt-dependent logprobs and continuations, and with branches that genuinely decode in
parallel the way the real exllamav3 backend does. Selected with BWBK_BACKEND=local.

This module owns the transport: it turns each request into engine sequence specs, then
shapes the engine's neutral per-sequence events into TabbyAPI's completion and chat SSE
envelopes (shared with the canned mock through bwbk.sse). The engine owns the model.

To change the model, edit REPO_ID and FILENAME below and re-run `just download-model`.
"""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from time import time

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from bwbk.engine import Engine, SeqSpec
from bwbk.sse import (
    DONE,
    chat_envelope,
    completion_envelope,
    new_request_id,
    top_map_to_chat_leaves,
)

router = APIRouter()

# --- Model spec (edit these two lines to swap the model, then `just download-model`) ---
REPO_ID = "ggml-org/gemma-3-270m-it-GGUF"
FILENAME = "gemma-3-270m-it-Q8_0.gguf"

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = MODEL_DIR / FILENAME
MODEL_ID = FILENAME.removesuffix(".gguf")

# KV budget shared across concurrent branches. There is no logits_all buffer, so a large
# context is cheap. MAX_SEQS branches decode together in one batch; extra requests queue.
N_CTX = 8192
MAX_SEQS = 16

_engine: Engine | None = None


def _engine_or_raise() -> Engine:
    if _engine is None:
        raise RuntimeError("Local model engine is not started.")
    return _engine


@asynccontextmanager
async def lifespan(app):
    """Load the model and start the engine once, at server startup."""
    global _engine
    if not MODEL_PATH.exists():
        raise RuntimeError(
            f"Local model not found at {MODEL_PATH}. Run `just download-model` first."
        )
    loop = asyncio.get_running_loop()
    engine = Engine(str(MODEL_PATH), n_ctx=N_CTX, max_seqs=MAX_SEQS)
    await loop.run_in_executor(None, engine.start)
    _engine = engine
    try:
        yield
    finally:
        engine.stop()
        _engine = None


class ChatMessage(BaseModel):
    role: str
    content: str | None = None


class CompletionRequest(BaseModel):
    prompt: str = ""
    n: int = 1
    stream: bool = True
    max_tokens: int = 400
    temperature: float = 1.0
    top_p: float = 1.0
    top_k: int = 0
    min_p: float = 0.0
    repetition_penalty: float | None = None
    min_tokens: int = 0
    stop: list[str] = Field(default_factory=list)
    banned_strings: list[str] = Field(default_factory=list)
    logprobs: int = 0
    top_logprobs: int = 0


class ChatCompletionRequest(BaseModel):
    messages: list[ChatMessage]
    response_prefix: str | None = None
    add_generation_prompt: bool = True
    n: int = 1
    stream: bool = True
    max_tokens: int = 128
    temperature: float = 1.0
    top_p: float = 1.0
    top_k: int = 0
    min_p: float = 0.0
    repetition_penalty: float | None = None
    min_tokens: int = 0
    stop: list[str] = Field(default_factory=list)
    banned_strings: list[str] = Field(default_factory=list)
    logprobs: int = 0
    top_logprobs: int = 0


class ModelLoadRequest(BaseModel):
    model_name: str = ""


class DownloadRequest(BaseModel):
    repo_id: str = ""
    revision: str | None = None
    folder_name: str | None = None


class TokenEncodeRequest(BaseModel):
    text: str
    add_bos_token: bool = True
    encode_special_tokens: bool = True


def _gemma_prompt(
    messages: list[ChatMessage], response_prefix: str, add_generation_prompt: bool
) -> str:
    """Wrap chat messages in Gemma's chat-turn template. Gemma has no system role, so a
    system message is emitted as a user turn. Tokenized with special=True so the turn
    markers become real special tokens, with BOS added automatically."""
    parts = []
    for message in messages:
        role = "model" if message.role == "assistant" else "user"
        parts.append(f"<start_of_turn>{role}\n{message.content or ''}<end_of_turn>\n")
    if add_generation_prompt:
        parts.append("<start_of_turn>model\n")
    parts.append(response_prefix)
    return "".join(parts)


def _gen_kwargs(data: CompletionRequest | ChatCompletionRequest) -> dict:
    """The sampler and control fields shared by every branch of a request."""
    return {
        "temperature": data.temperature,
        "top_p": data.top_p,
        "top_k": data.top_k,
        "min_p": data.min_p,
        "repetition_penalty": data.repetition_penalty,
        "min_tokens": data.min_tokens,
        "stop": tuple(data.stop),
        "banned_strings": tuple(data.banned_strings),
    }


def _specs(engine: Engine, data, prompt: str) -> list[SeqSpec]:
    """Build the sequence specs for a request: one probe when the client asks for the
    first-token distribution, otherwise one gen branch per n."""
    prompt_tokens = engine.tokenize(prompt, add_bos=True, special=True)
    if data.max_tokens <= 1 and (data.top_logprobs > 0 or data.logprobs > 0):
        k = max(data.top_logprobs, data.logprobs)
        return [SeqSpec(prompt_tokens=prompt_tokens, index=0, max_tokens=1, kind="probe", k=k)]
    kwargs = _gen_kwargs(data)
    return [
        SeqSpec(prompt_tokens=prompt_tokens, index=i, max_tokens=data.max_tokens, **kwargs)
        for i in range(max(1, data.n))
    ]


def _token_frame(request_id: str, index: int, text: str, chat: bool) -> str:
    if chat:
        return chat_envelope(
            request_id,
            [{"index": index, "delta": {"content": text}, "finish_reason": None}],
            MODEL_ID,
        )
    return completion_envelope(
        request_id, [{"index": index, "text": text, "finish_reason": None}], model=MODEL_ID
    )


def _finish_frame(request_id: str, index: int, reason: str, chat: bool) -> str:
    if chat:
        return chat_envelope(
            request_id, [{"index": index, "delta": {}, "finish_reason": reason}], MODEL_ID
        )
    return completion_envelope(
        request_id, [{"index": index, "text": "", "finish_reason": reason}], model=MODEL_ID
    )


def _probe_frame(request_id: str, index: int, event: dict, chat: bool) -> str:
    token = event["token"]
    logprob = event["logprob"]
    top = event["top"]
    if chat:
        return chat_envelope(
            request_id,
            [
                {
                    "index": index,
                    "delta": {"content": token},
                    "finish_reason": None,
                    "logprobs": {
                        "content": [
                            {
                                "token": token,
                                "logprob": logprob,
                                "top_logprobs": top_map_to_chat_leaves(top),
                            }
                        ]
                    },
                }
            ],
            MODEL_ID,
        )
    return completion_envelope(
        request_id,
        [
            {
                "index": index,
                "text": token,
                "finish_reason": None,
                "logprobs": {
                    "tokens": [token],
                    "token_logprobs": [logprob],
                    "top_logprobs": [top],
                    "text_offset": [0],
                },
            }
        ],
        model=MODEL_ID,
    )


async def _run(request: Request, specs: list[SeqSpec], chat: bool):
    """Submit the specs to the engine and stream its events as SSE frames."""
    engine = _engine_or_raise()
    request_id = new_request_id()
    queue: asyncio.Queue = asyncio.Queue()
    engine.submit(specs, queue, asyncio.get_running_loop())
    remaining = len(specs)
    while remaining > 0:
        event = await queue.get()
        if await request.is_disconnected():
            break
        kind = event["kind"]
        index = event["index"]
        if kind == "token":
            yield _token_frame(request_id, index, event["text"], chat)
        elif kind == "finish":
            yield _finish_frame(request_id, index, event["reason"], chat)
            remaining -= 1
        elif kind == "probe":
            yield _probe_frame(request_id, index, event, chat)
            yield _finish_frame(request_id, index, "length", chat)
            remaining -= 1
        elif kind == "error":
            yield _finish_frame(request_id, index, "error", chat)
            remaining -= 1
    yield DONE


@router.post("/api/completions")
async def completions(request: Request, data: CompletionRequest):
    specs = _specs(_engine_or_raise(), data, data.prompt)
    return EventSourceResponse(_run(request, specs, chat=False))


@router.post("/api/chat/completions")
async def chat_completions(request: Request, data: ChatCompletionRequest):
    prompt = _gemma_prompt(data.messages, data.response_prefix or "", data.add_generation_prompt)
    specs = _specs(_engine_or_raise(), data, prompt)
    return EventSourceResponse(_run(request, specs, chat=True))


def _model_info() -> dict:
    return {
        "id": MODEL_ID,
        "object": "model",
        "created": int(time()),
        "owned_by": "tabbyAPI",
        "logging": None,
        "parameters": {
            "max_seq_len": N_CTX,
            "cache_size": N_CTX,
            "cache_mode": "FP16",
            "rope_scale": 1.0,
            "rope_alpha": 1.0,
            # Branches the engine decodes together in one batch. The client reads this as the
            # branch-count ceiling; extra branches beyond it just queue.
            "max_batch_size": MAX_SEQS,
            "chunk_size": 2048,
            "prompt_template": None,
            "prompt_template_content": None,
            "use_vision": False,
            "draft": None,
        },
    }


@router.get("/api/tabby/model")
async def current_model():
    return _model_info()


@router.get("/api/tabby/models")
async def list_models():
    return {"object": "list", "data": [_model_info()]}


@router.post("/api/tabby/model/load")
async def load_model(data: ModelLoadRequest):
    """The local model loads once at startup. Report an immediate finished stream so the
    in-app model panel completes its load flow."""

    async def progress():
        yield json.dumps({"model_type": "model", "module": 1, "modules": 1, "status": "finished"})

    return EventSourceResponse(progress())


@router.post("/api/tabby/model/unload")
async def unload_model():
    return {"unloaded": True}


@router.post("/api/tabby/download")
async def download_model(data: DownloadRequest):
    folder = data.folder_name or (data.repo_id.split("/")[-1] if data.repo_id else MODEL_ID)
    return {"download_path": f"/local-models/{folder}"}


@router.post("/api/tabby/token/encode")
async def encode_tokens(data: TokenEncodeRequest):
    engine = _engine_or_raise()
    tokens = engine.tokenize(
        data.text, add_bos=data.add_bos_token, special=data.encode_special_tokens
    )
    return {"tokens": [int(t) for t in tokens], "length": len(tokens)}
