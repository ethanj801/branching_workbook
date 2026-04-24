"""
Mock TabbyAPI-compatible completions endpoint.

Emits SSE chunks in the same format TabbyAPI's /v1/completions uses (sibling
checkout at ../tabbyAPI: endpoints/OAI/utils/completion.py), so the client can
be built and tested without a real inference backend. When the real proxy
replaces this in Phase 4, nothing on the client should need to change.

Phase 1 scope: only index=0 is emitted. Phase 3 will respect `n > 1`.
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

    text = random.choice(SAMPLE_CONTINUATIONS)

    # Emit 3–8 char slices to approximate token-sized chunks
    i = 0
    emitted = 0
    char_budget = data.max_tokens * 4  # rough char-to-token conversion
    while i < len(text) and emitted < char_budget:
        if await request.is_disconnected():
            return
        n_chars = random.randint(3, 8)
        delta = text[i : i + n_chars]
        i += n_chars
        emitted += len(delta)
        yield _chunk_envelope(
            request_id,
            [{"index": 0, "text": delta, "finish_reason": None}],
        )
        await asyncio.sleep(chunk_delay)

    finish = "stop" if i >= len(text) else "length"
    yield _chunk_envelope(
        request_id,
        [{"index": 0, "text": "", "finish_reason": finish}],
    )
    yield "[DONE]"


@router.post("/api/completions")
async def completions(request: Request, data: CompletionRequest):
    return EventSourceResponse(_stream_mock_completion(request, data))
