"""Shared TabbyAPI-compatible SSE envelope and logprobs shaping.

The `tabby` proxy forwards TabbyAPI's bytes untouched. The two fake backends, the
canned mock (`bwbk.mock`) and the in-process local LLM (`bwbk.local`), instead
reconstruct TabbyAPI's completion and chat wire shapes by hand. Keeping that shape in
one module means both fakes emit byte-identical framing and stay pinned by one set of
wire-format tests (`server/tests/test_mock.py`).
"""

import json
from time import time
from uuid import uuid4

from fastapi import HTTPException

# The final SSE frame. sse_starlette wraps each yielded string as a `data:` line, so
# yielding this produces `data: [DONE]`, matching TabbyAPI's stream terminator.
DONE = "[DONE]"


def new_request_id() -> str:
    """A fresh request id, hex like TabbyAPI's."""
    return uuid4().hex


def completion_envelope(request_id: str, choices: list[dict], model: str = "mock") -> str:
    """One TabbyAPI CompletionResponse streaming chunk (object text_completion)."""
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


def chat_envelope(request_id: str, choices: list[dict], model_name: str) -> str:
    """One TabbyAPI chat completion streaming chunk."""
    return json.dumps(
        {
            "id": f"chatcmpl-{request_id}",
            "choices": choices,
            "model_name": model_name,
        },
        ensure_ascii=False,
    )


def validate_continue_final_message(data) -> None:
    """Reject the continue_final_message request shapes TabbyAPI rejects.
    Both fake backends apply the same rules so the client sees the same 422s
    it would get from the real server. `data` is either backend's
    ChatCompletionRequest."""
    if not data.continue_final_message:
        return
    if data.add_generation_prompt:
        raise HTTPException(
            422, "continue_final_message requires add_generation_prompt to be false"
        )
    if not data.messages or data.messages[-1].content is None:
        raise HTTPException(
            422,
            "continue_final_message is set but there is no final message "
            "content to continue",
        )


def top_map_to_chat_leaves(top_map: dict[str, float]) -> list[dict]:
    """Turn a completion-shape {token: logprob} map into the chat shape's ranked list
    of {token, logprob} leaves. TabbyAPI keeps the two logprob shapes in sync the same
    way (see chat_logprobs_to_completion_logprobs in the real server). Callers pass an
    already-ranked map so the leaf order is the rank order."""
    return [{"token": token, "logprob": logprob} for token, logprob in top_map.items()]
