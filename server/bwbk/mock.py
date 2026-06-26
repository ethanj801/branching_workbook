"""
Mock TabbyAPI-compatible completions endpoint.

Emits SSE chunks in the same format TabbyAPI's /v1/completions uses (sibling
checkout at ../tabbyAPI: endpoints/OAI/utils/completion.py), so the client can
be built and tested without a real inference backend. When the real proxy
replaces this in Phase 4, nothing on the client should need to change.

Supports `n > 1` by emitting interleaved chunks with per-branch choice indexes,
matching the client contract used by the real TabbyAPI proxy later.
"""

import asyncio
import json
import random
from time import time
from uuid import uuid4

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

router = APIRouter()

MOCK_MODEL_ID = "mock-gemma-3-270m-exl3"
MOCK_MODELS = [
    {
        "id": MOCK_MODEL_ID,
        "object": "model",
        "created": int(time()),
        "owned_by": "tabbyAPI",
        "logging": None,
        "parameters": None,
    }
]
loaded_model: dict | None = {
    "id": MOCK_MODEL_ID,
    "object": "model",
    "created": int(time()),
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

SAMPLE_CONTINUATIONS = [
    " The wind picked up just as the last light drained from the sky, and for a moment "
    "everything held perfectly still — the kind of stillness that always seems to come "
    "right before something breaks.",
    " She hadn't meant to say it out loud. The words were out before she could catch them, "
    "and now they sat in the room between them like a small animal neither of them knew "
    "how to handle.",
    " The letter was dated three years ago. He turned it over in his hands twice, as if "
    "the back might explain why it had arrived this morning, and not some other morning, "
    "and not any of the hundreds of mornings in between.",
    " There was a door at the top of the stairs that nobody in the family had opened in "
    "as long as Marlowe could remember. Tonight, for reasons she could not have named even "
    "to herself, she climbed the stairs and stood in front of it.",
]


class CompletionRequest(BaseModel):
    prompt: str
    n: int = 1
    stream: bool = True
    max_tokens: int = 400
    temperature: float = 1.0
    top_p: float = 1.0
    stop: list[str] = Field(default_factory=list)
    logprobs: int = 0
    top_logprobs: int = 0


class ChatMessage(BaseModel):
    role: str
    content: str | None = None


class ChatCompletionRequest(BaseModel):
    messages: list[ChatMessage]
    response_prefix: str | None = None
    add_generation_prompt: bool = True
    n: int = 1
    stream: bool = True
    max_tokens: int = 128
    temperature: float = 1.0
    top_p: float = 1.0
    logprobs: int = 0
    top_logprobs: int = 0


class ModelLoadRequest(BaseModel):
    model_name: str
    max_seq_len: int | None = None
    cache_size: int | None = None
    cache_mode: str | None = None
    tensor_parallel: bool | None = None
    tensor_parallel_backend: str | None = None
    gpu_split_auto: bool | None = None
    autosplit_reserve: list[float] | None = None
    gpu_split: list[float] | None = None


class DownloadRequest(BaseModel):
    repo_id: str
    revision: str | None = None
    folder_name: str | None = None


class TokenEncodeRequest(BaseModel):
    text: str
    add_bos_token: bool = True
    encode_special_tokens: bool = True


# Distinct first-token candidates the mock returns as top_logprobs, ranked by
# descending logprob. Seeding reads these to start each branch from a different
# opening. Real backends derive them from the model. The mock uses a fixed set
# so the seeded path has deterministic local coverage.
OPENING_TOKENS = [
    " The",
    " She",
    " There",
    " He",
    " It",
    " A",
    " They",
    " Outside",
    " Rain",
    " Nobody",
    " Somewhere",
    " When",
]


def _top_logprobs_map(k: int) -> dict[str, float]:
    """A ranked token-to-logprob map of up to k distinct opening tokens."""
    count = max(1, min(k, len(OPENING_TOKENS)))
    return {OPENING_TOKENS[i]: -(0.2 + 0.35 * i) for i in range(count)}


def _logprobs_request(
    data: CompletionRequest | ChatCompletionRequest,
) -> tuple[bool, int]:
    """Whether to attach the opening distribution, and how many tokens to send.
    top_logprobs and logprobs both gate it. top_logprobs sets the count on the
    exllamav3 path and logprobs on the exllamav2 path, so the mock honors
    whichever a client sets. Shared so both endpoints keep one gating rule."""
    want = data.top_logprobs > 0 or data.logprobs > 0
    return want, max(data.top_logprobs, data.logprobs)


def _continuation_start(text: str) -> int:
    """Stable offset into the canned continuations derived from the prompt, so
    different prompts (and so different seeds) pick different continuations."""
    return sum(ord(ch) for ch in text)


def _chunk_envelope(request_id: str, choices: list[dict], model: str = "mock") -> str:
    """Match TabbyAPI's CompletionResponse streaming envelope shape."""
    return json.dumps(
        {
            "id": f"cmpl-{request_id}",
            "object": "text_completion",
            "created": int(time()),
            "model": model,
            "choices": choices,
        },
        ensure_ascii=False,
    )


async def _stream_mock_completion(request: Request, data: CompletionRequest):
    request_id = uuid4().hex
    chunk_delay = 0.03  # ~30ms between chunks, feels live
    branch_count = max(1, data.n)
    char_budget = data.max_tokens * 4  # rough char-to-token conversion

    start = _continuation_start(data.prompt)
    texts = [
        SAMPLE_CONTINUATIONS[(start + index) % len(SAMPLE_CONTINUATIONS)]
        for index in range(branch_count)
    ]
    offsets = [0 for _ in range(branch_count)]
    emitted = [0 for _ in range(branch_count)]
    finished = [False for _ in range(branch_count)]
    want_logprobs, top_k = _logprobs_request(data)
    logprobs_sent = [False for _ in range(branch_count)]

    # Emit 3-8 char slices per branch to approximate token-sized chunks.
    while not all(finished):
        for index, text in enumerate(texts):
            if finished[index]:
                continue
            if await request.is_disconnected():
                return

            if offsets[index] >= len(text) or emitted[index] >= char_budget:
                finished[index] = True
                finish = "stop" if offsets[index] >= len(text) else "length"
                yield _chunk_envelope(
                    request_id,
                    [{"index": index, "text": "", "finish_reason": finish}],
                )
                continue

            n_chars = random.randint(3, 8)
            delta = text[offsets[index] : offsets[index] + n_chars]
            offsets[index] += n_chars
            emitted[index] += len(delta)
            choice = {"index": index, "text": delta, "finish_reason": None}
            # Attach the first token's distribution once per branch, matching
            # TabbyAPI's completion logprobs shape (top_logprobs is a list of
            # token-to-logprob maps, one per position).
            if want_logprobs and not logprobs_sent[index]:
                logprobs_sent[index] = True
                choice["logprobs"] = {
                    "tokens": [delta],
                    "token_logprobs": [-0.2],
                    "top_logprobs": [_top_logprobs_map(top_k)],
                    "text_offset": [0],
                }
            yield _chunk_envelope(request_id, [choice])
            await asyncio.sleep(chunk_delay)

    yield "[DONE]"


async def _stream_mock_chat_completion(request: Request, data: ChatCompletionRequest):
    request_id = uuid4().hex
    chunk_delay = 0.03
    branch_count = max(1, data.n)
    char_budget = data.max_tokens * 4
    prefix = data.response_prefix or ""

    start = _continuation_start(
        prefix + "".join(message.content or "" for message in data.messages)
    )
    texts = [
        f"{prefix}{SAMPLE_CONTINUATIONS[(start + index) % len(SAMPLE_CONTINUATIONS)]}"
        for index in range(branch_count)
    ]
    offsets = [len(prefix) for _ in range(branch_count)]
    emitted = [0 for _ in range(branch_count)]
    finished = [False for _ in range(branch_count)]
    want_logprobs, top_k = _logprobs_request(data)
    logprobs_sent = [False for _ in range(branch_count)]

    while not all(finished):
        for index, text in enumerate(texts):
            if finished[index]:
                continue
            if await request.is_disconnected():
                return

            if offsets[index] >= len(text) or emitted[index] >= char_budget:
                finished[index] = True
                finish = "stop" if offsets[index] >= len(text) else "length"
                yield json.dumps(
                    {
                        "id": f"chatcmpl-{request_id}",
                        "choices": [
                            {
                                "index": index,
                                "delta": {},
                                "finish_reason": finish,
                            }
                        ],
                        "model_name": MOCK_MODEL_ID,
                    },
                    ensure_ascii=False,
                )
                continue

            n_chars = random.randint(3, 8)
            delta = text[offsets[index] : offsets[index] + n_chars]
            offsets[index] += n_chars
            emitted[index] += len(delta)
            choice = {
                "index": index,
                "delta": {"content": delta},
                "finish_reason": None,
            }
            # Attach the first token's distribution once per branch, matching
            # TabbyAPI's chat logprobs shape (content[i].top_logprobs is a ranked
            # list of token/logprob leaves).
            if want_logprobs and not logprobs_sent[index]:
                logprobs_sent[index] = True
                choice["logprobs"] = {
                    "content": [
                        {
                            "token": delta,
                            "logprob": -0.2,
                            "top_logprobs": [
                                {"token": token, "logprob": logprob}
                                for token, logprob in _top_logprobs_map(top_k).items()
                            ],
                        }
                    ]
                }
            yield json.dumps(
                {
                    "id": f"chatcmpl-{request_id}",
                    "choices": [choice],
                    "model_name": MOCK_MODEL_ID,
                },
                ensure_ascii=False,
            )
            await asyncio.sleep(chunk_delay)

    yield "[DONE]"


@router.post("/api/completions")
async def completions(request: Request, data: CompletionRequest):
    return EventSourceResponse(_stream_mock_completion(request, data))


@router.post("/api/chat/completions")
async def chat_completions(request: Request, data: ChatCompletionRequest):
    return EventSourceResponse(_stream_mock_chat_completion(request, data))


@router.get("/api/tabby/model")
async def current_model():
    return loaded_model


@router.get("/api/tabby/models")
async def list_models():
    return {"object": "list", "data": MOCK_MODELS}


async def _stream_mock_model_load(data: ModelLoadRequest):
    global loaded_model

    for module in range(1, 4):
        yield json.dumps(
            {
                "model_type": "model",
                "module": module,
                "modules": 3,
                "status": "processing" if module < 3 else "finished",
            }
        )
        await asyncio.sleep(0.03)

    loaded_model = {
        "id": data.model_name,
        "object": "model",
        "created": int(time()),
        "owned_by": "tabbyAPI",
        "logging": None,
        "parameters": {
            "max_seq_len": data.max_seq_len or 4096,
            "cache_size": data.cache_size or data.max_seq_len or 4096,
            "cache_mode": data.cache_mode or "Q6",
            "tensor_parallel": data.tensor_parallel,
            "tensor_parallel_backend": data.tensor_parallel_backend,
            "gpu_split_auto": data.gpu_split_auto,
            "autosplit_reserve": data.autosplit_reserve,
            "gpu_split": data.gpu_split,
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


@router.post("/api/tabby/model/load")
async def load_model(data: ModelLoadRequest):
    return EventSourceResponse(_stream_mock_model_load(data))


@router.post("/api/tabby/model/unload")
async def unload_model():
    global loaded_model
    loaded_model = None
    return {"unloaded": True}


@router.post("/api/tabby/download")
async def download_model(data: DownloadRequest):
    folder = data.folder_name or data.repo_id.split("/")[-1]
    model_id = folder
    if not any(model["id"] == model_id for model in MOCK_MODELS):
        MOCK_MODELS.append(
            {
                "id": model_id,
                "object": "model",
                "created": int(time()),
                "owned_by": "tabbyAPI",
                "logging": None,
                "parameters": None,
            }
        )
    return {"download_path": f"/mock-models/{folder}"}


@router.post("/api/tabby/token/encode")
async def encode_tokens(data: TokenEncodeRequest):
    token_count = len(data.text.split())
    if data.add_bos_token:
        token_count += 1
    return {"tokens": list(range(token_count)), "length": token_count}
