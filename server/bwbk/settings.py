"""Per-project UI settings stored in the project_meta table."""

from __future__ import annotations

import json
import sqlite3
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from bwbk.db import WRITE_LOCK, _require_conn

router = APIRouter()

DISPLAY_MODE_KEY = "display_mode"
BRANCH_COUNT_KEY = "branch_count"
MAX_TOKENS_KEY = "max_tokens"
TOKENS_PER_SUGGESTION_KEY = "tokens_per_suggestion"
SEEDED_BRANCHES_KEY = "seeded_branches"
BANNED_STRINGS_KEY = "banned_strings"
BANNED_STRINGS_ENABLED_KEY = "banned_strings_enabled"


class ProjectSettings(BaseModel):
    display_mode: Literal["cards", "inline"] = "cards"
    branch_count: int = Field(default=3, ge=1)
    max_tokens: int = Field(default=256, ge=1)
    tokens_per_suggestion: int = Field(default=2, ge=1, le=8)
    seeded_branches: bool = False
    banned_strings: list[str] = Field(default_factory=list)
    banned_strings_enabled: bool = True


class ProjectSettingsPatch(BaseModel):
    display_mode: Literal["cards", "inline"] | None = None
    branch_count: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1)
    tokens_per_suggestion: int | None = Field(default=None, ge=1, le=8)
    seeded_branches: bool | None = None
    banned_strings: list[str] | None = None
    banned_strings_enabled: bool | None = None


def _read_int(meta: dict[str, str | None], key: str, default: int) -> int:
    try:
        value = int(meta.get(key) or default)
    except (TypeError, ValueError):
        return default
    return max(1, value)


def _read_bool(meta: dict[str, str | None], key: str, default: bool) -> bool:
    value = meta.get(key)
    if value is None:
        return default
    return value in {"1", "true", "True"}


def _read_str_list(meta: dict[str, str | None], key: str) -> list[str]:
    raw = meta.get(key)
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


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
        seeded_branches=_read_bool(meta, SEEDED_BRANCHES_KEY, False),
        banned_strings=_read_str_list(meta, BANNED_STRINGS_KEY),
        banned_strings_enabled=_read_bool(meta, BANNED_STRINGS_ENABLED_KEY, True),
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
    if data.seeded_branches is not None:
        updates[SEEDED_BRANCHES_KEY] = "1" if data.seeded_branches else "0"
    if data.banned_strings is not None:
        updates[BANNED_STRINGS_KEY] = json.dumps(data.banned_strings)
    if data.banned_strings_enabled is not None:
        updates[BANNED_STRINGS_ENABLED_KEY] = (
            "1" if data.banned_strings_enabled else "0"
        )

    with WRITE_LOCK, conn:
        for key, value in updates.items():
            conn.execute(
                """
                INSERT INTO project_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )
    return _read_settings(conn)
