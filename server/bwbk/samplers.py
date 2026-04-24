"""Sampler presets + active-preset selection.

Presets are user-global (stored in `bwbk.userdata`, shared across every
project). The *active* preset id is per-project, kept in the project's
`project_meta` under `active_sampler_preset_id` — a confidential project
doesn't share its "which preset is active" choice with other projects, and
dropping the user-global store never removes a project's selection.

The preset `body` is a free-form JSON dict. Fields that match TabbyAPI's
`BaseSamplerRequest` (temperature, top_p, min_p, xtc_*, dry_*, etc.) are
merged into the completion request body by the client. Unknown fields are
allowed at rest but dropped at request time by the client's
`samplerToCompletionBody` — this keeps future TabbyAPI additions storable
without a migration.
"""

from __future__ import annotations

import datetime as _dt
import json
import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from bwbk.db import _require_conn
from bwbk.userdata import get_conn as get_userdata

router = APIRouter()

ACTIVE_PRESET_KEY = "active_sampler_preset_id"


def _now_iso() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")


class SamplerPreset(BaseModel):
    id: str
    name: str
    body: dict[str, Any] = Field(default_factory=dict)
    is_starter: bool = False
    created_at: str
    updated_at: str


class PresetCreate(BaseModel):
    name: str
    body: dict[str, Any] = Field(default_factory=dict)


class PresetUpdate(BaseModel):
    name: str | None = None
    body: dict[str, Any] | None = None


class ActivePreset(BaseModel):
    preset_id: str | None


def _row_to_preset(r: sqlite3.Row) -> SamplerPreset:
    return SamplerPreset(
        id=r["id"],
        name=r["name"],
        body=json.loads(r["body"]) if r["body"] else {},
        is_starter=bool(r["is_starter"]),
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


@router.get("/api/samplers/presets", response_model=list[SamplerPreset])
def list_presets() -> list[SamplerPreset]:
    conn = get_userdata()
    rows = conn.execute(
        "SELECT * FROM sampler_presets ORDER BY is_starter DESC, lower(name) ASC"
    ).fetchall()
    return [_row_to_preset(r) for r in rows]


@router.post("/api/samplers/presets", response_model=SamplerPreset)
def create_preset(data: PresetCreate) -> SamplerPreset:
    if not data.name.strip():
        raise HTTPException(status_code=422, detail="Preset name is required.")
    conn = get_userdata()
    now = _now_iso()
    preset_id = str(uuid.uuid4())
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO sampler_presets (
                    id, name, body, is_starter, created_at, updated_at
                ) VALUES (?, ?, ?, 0, ?, ?)
                """,
                (preset_id, data.name.strip(), json.dumps(data.body), now, now),
            )
    except sqlite3.IntegrityError as ex:
        raise HTTPException(
            status_code=409, detail=f"A preset named {data.name!r} already exists."
        ) from ex
    row = conn.execute(
        "SELECT * FROM sampler_presets WHERE id = ?", (preset_id,)
    ).fetchone()
    return _row_to_preset(row)


@router.put("/api/samplers/presets/{preset_id}", response_model=SamplerPreset)
def update_preset(preset_id: str, data: PresetUpdate) -> SamplerPreset:
    conn = get_userdata()
    row = conn.execute(
        "SELECT * FROM sampler_presets WHERE id = ?", (preset_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Preset not found.")

    new_name = row["name"] if data.name is None else data.name.strip()
    if not new_name:
        raise HTTPException(status_code=422, detail="Preset name cannot be empty.")
    new_body = json.loads(row["body"]) if data.body is None else data.body

    try:
        with conn:
            conn.execute(
                """
                UPDATE sampler_presets
                SET name = ?, body = ?, updated_at = ?
                WHERE id = ?
                """,
                (new_name, json.dumps(new_body), _now_iso(), preset_id),
            )
    except sqlite3.IntegrityError as ex:
        raise HTTPException(
            status_code=409, detail=f"A preset named {new_name!r} already exists."
        ) from ex
    row = conn.execute(
        "SELECT * FROM sampler_presets WHERE id = ?", (preset_id,)
    ).fetchone()
    return _row_to_preset(row)


@router.delete("/api/samplers/presets/{preset_id}")
def delete_preset(preset_id: str) -> dict[str, bool]:
    conn = get_userdata()
    row = conn.execute(
        "SELECT id FROM sampler_presets WHERE id = ?", (preset_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Preset not found.")
    with conn:
        conn.execute("DELETE FROM sampler_presets WHERE id = ?", (preset_id,))
    return {"deleted": True}


@router.get("/api/samplers/active", response_model=ActivePreset)
def get_active_preset(request: Request) -> ActivePreset:
    conn = _require_conn(request)
    row = conn.execute(
        "SELECT value FROM project_meta WHERE key = ?", (ACTIVE_PRESET_KEY,)
    ).fetchone()
    return ActivePreset(preset_id=row["value"] if row else None)


@router.put("/api/samplers/active", response_model=ActivePreset)
def set_active_preset(data: ActivePreset, request: Request) -> ActivePreset:
    conn = _require_conn(request)
    if data.preset_id is not None:
        exists = get_userdata().execute(
            "SELECT id FROM sampler_presets WHERE id = ?", (data.preset_id,)
        ).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Preset not found.")
    with conn:
        if data.preset_id is None:
            conn.execute(
                "DELETE FROM project_meta WHERE key = ?", (ACTIVE_PRESET_KEY,)
            )
        else:
            conn.execute(
                """
                INSERT INTO project_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (ACTIVE_PRESET_KEY, data.preset_id),
            )
    return ActivePreset(preset_id=data.preset_id)
