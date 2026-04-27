"""Per-project UI settings stored in the project_meta table."""

from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter()

DISPLAY_MODE_KEY = "display_mode"
BRANCH_COUNT_KEY = "branch_count"
MAX_TOKENS_KEY = "max_tokens"
TOKENS_PER_SUGGESTION_KEY = "tokens_per_suggestion"


class ProjectSettings(BaseModel):
    display_mode: Literal["cards", "inline"] = "cards"
    branch_count: int = Field(default=3, ge=1)
    max_tokens: int = Field(default=256, ge=1)
    tokens_per_suggestion: int = Field(default=2, ge=1, le=8)


class ProjectSettingsPatch(BaseModel):
    display_mode: Literal["cards", "inline"] | None = None
    branch_count: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1)
    tokens_per_suggestion: int | None = Field(default=None, ge=1, le=8)


def _require_conn(request: Request) -> sqlite3.Connection:
    conn = getattr(request.app.state, "conn", None)
    if conn is None:
        raise HTTPException(status_code=409, detail="No project is open.")
    return conn


def _read_int(meta: dict[str, str | None], key: str, default: int) -> int:
    try:
        value = int(meta.get(key) or default)
    except (TypeError, ValueError):
        return default
    return max(1, value)


def _read_settings(conn: sqlite3.Connection) -> ProjectSettings:
    meta = {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM project_meta")
    }
    display_mode = meta.get(DISPLAY_MODE_KEY)
    return ProjectSettings(
        display_mode=display_mode if display_mode in {"cards", "inline"} else "cards",
        branch_count=_read_int(meta, BRANCH_COUNT_KEY, 3),
        max_tokens=_read_int(meta, MAX_TOKENS_KEY, 256),
        tokens_per_suggestion=min(
            8, _read_int(meta, TOKENS_PER_SUGGESTION_KEY, 2)
        ),
    )


@router.get("/api/project/settings", response_model=ProjectSettings)
def get_project_settings(request: Request) -> ProjectSettings:
    return _read_settings(_require_conn(request))


@router.put("/api/project/settings", response_model=ProjectSettings)
def update_project_settings(
    data: ProjectSettingsPatch, request: Request
) -> ProjectSettings:
    conn = _require_conn(request)
    updates: dict[str, str] = {}
    if data.display_mode is not None:
        updates[DISPLAY_MODE_KEY] = data.display_mode
    if data.branch_count is not None:
        updates[BRANCH_COUNT_KEY] = str(data.branch_count)
    if data.max_tokens is not None:
        updates[MAX_TOKENS_KEY] = str(data.max_tokens)
    if data.tokens_per_suggestion is not None:
        updates[TOKENS_PER_SUGGESTION_KEY] = str(data.tokens_per_suggestion)

    with conn:
        for key, value in updates.items():
            conn.execute(
                """
                INSERT INTO project_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )
    return _read_settings(conn)
