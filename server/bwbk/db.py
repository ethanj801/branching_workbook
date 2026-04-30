"""SQLite persistence for Branching Workbook projects (spec §8).

The server is intentionally dumb about trees: it knows how to read, write, and
atomically mutate rows, but it does not execute the §3.1 reshape algorithm —
that lives on the client in `client/src/tree/reshape.ts`. A commit is modeled
as a `MutationBatch` coming down from a reshape call; the server applies
creates / updates / deletes in one SQLite transaction and flips the
`is_main_path` flags when a new `main_path` is supplied.
"""

from __future__ import annotations

import datetime as _dt
import json
import sqlite3
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter()

SCHEMA = """
CREATE TABLE IF NOT EXISTS project_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id                   TEXT PRIMARY KEY,
    parent_id            TEXT REFERENCES nodes(id),
    text                 TEXT NOT NULL,
    name                 TEXT,
    source               TEXT NOT NULL,
    hidden               INTEGER NOT NULL DEFAULT 0,
    is_main_path         INTEGER NOT NULL DEFAULT 0,
    starred              INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    sampler_snapshot     TEXT,
    seed                 INTEGER,
    model_identifier     TEXT,
    prior_context_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_main
    ON nodes(is_main_path) WHERE is_main_path = 1;
"""
# User-global preferences (e.g. sampler presets) live in `bwbk.userdata`,
# NOT in the project DB, so confidential project folders don't have to carry
# cross-project settings. Per-project state that *does* belong here (like the
# currently-active sampler preset id) goes in `project_meta` under
# well-known keys (`active_sampler_preset_id`).


def open_db(path: str | Path) -> sqlite3.Connection:
    # check_same_thread=False: FastAPI runs sync handlers on a threadpool, so
    # the connection must be usable from any worker thread. Single-user local
    # tool, so we don't need cross-thread write serialization beyond what
    # SQLite already does.
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    with conn:
        conn.executescript(SCHEMA)
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(nodes)").fetchall()
        }
        if "name" not in columns:
            conn.execute("ALTER TABLE nodes ADD COLUMN name TEXT")
        if "starred" not in columns:
            conn.execute(
                "ALTER TABLE nodes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"
            )


class NodeModel(BaseModel):
    id: str
    parent_id: str | None
    text: str
    name: str | None = None
    source: Literal["generated", "user_written", "composed"]
    hidden: bool = False
    is_main_path: bool = False
    starred: bool = False
    created_at: int
    prior_context_hash: str
    sampler_snapshot: dict | None = None
    seed: int | None = None
    model_identifier: str | None = None


class CreateProjectRequest(BaseModel):
    path: str
    title: str | None = None


class OpenProjectRequest(BaseModel):
    path: str


class ProjectInfo(BaseModel):
    path: str
    title: str | None = None
    created_at: str | None = None
    version: str = "1"


class MutationBatch(BaseModel):
    creates: list[NodeModel] = Field(default_factory=list)
    updates: list[NodeModel] = Field(default_factory=list)
    deletes: list[str] = Field(default_factory=list)
    main_path: list[str] | None = None


def _now_iso() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")


def _now_epoch() -> int:
    return int(_dt.datetime.now(_dt.UTC).timestamp())


def _project_info(conn: sqlite3.Connection, path: str) -> ProjectInfo:
    meta = {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM project_meta")
    }
    return ProjectInfo(
        path=path,
        title=meta.get("title"),
        created_at=meta.get("created_at"),
        version=meta.get("version", "1"),
    )


def _validate_project(conn: sqlite3.Connection) -> None:
    try:
        meta = {
            row["key"]: row["value"]
            for row in conn.execute("SELECT key, value FROM project_meta")
        }
        root = conn.execute(
            "SELECT id, parent_id FROM nodes WHERE id = 'root'"
        ).fetchone()
    except sqlite3.DatabaseError as ex:
        raise HTTPException(
            status_code=400, detail="Not a Branching Workbook project file."
        ) from ex

    if meta.get("version") != "1":
        raise HTTPException(
            status_code=400, detail="Not a Branching Workbook project file."
        )
    if root is None or root["parent_id"] is not None:
        raise HTTPException(
            status_code=400, detail="Project file is missing its root node."
        )


def _require_conn(request: Request) -> sqlite3.Connection:
    conn: sqlite3.Connection | None = getattr(request.app.state, "conn", None)
    if conn is None:
        raise HTTPException(status_code=409, detail="No project is currently open.")
    return conn


def _close_current(request: Request) -> None:
    conn = getattr(request.app.state, "conn", None)
    if conn is not None:
        conn.close()
        delattr(request.app.state, "conn")
    if hasattr(request.app.state, "project_path"):
        delattr(request.app.state, "project_path")


def _row_to_node(r: sqlite3.Row) -> NodeModel:
    return NodeModel(
        id=r["id"],
        parent_id=r["parent_id"],
        text=r["text"],
        name=r["name"],
        source=r["source"],
        hidden=bool(r["hidden"]),
        is_main_path=bool(r["is_main_path"]),
        starred=bool(r["starred"]) if "starred" in r else False,
        created_at=r["created_at"],
        prior_context_hash=r["prior_context_hash"],
        sampler_snapshot=(
            json.loads(r["sampler_snapshot"]) if r["sampler_snapshot"] else None
        ),
        seed=r["seed"],
        model_identifier=r["model_identifier"],
    )


def _insert_node(conn: sqlite3.Connection, n: NodeModel) -> None:
    conn.execute(
        """
        INSERT INTO nodes (
            id, parent_id, text, name, source, hidden, is_main_path, starred,
            created_at, sampler_snapshot, seed, model_identifier, prior_context_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            n.id,
            n.parent_id,
            n.text,
            n.name,
            n.source,
            int(n.hidden),
            int(n.is_main_path),
            int(n.starred),
            n.created_at,
            json.dumps(n.sampler_snapshot) if n.sampler_snapshot is not None else None,
            n.seed,
            n.model_identifier,
            n.prior_context_hash,
        ),
    )


def _update_node(conn: sqlite3.Connection, n: NodeModel) -> None:
    conn.execute(
        """
        UPDATE nodes
        SET parent_id = ?, text = ?, name = ?, source = ?, hidden = ?, is_main_path = ?,
            starred = ?, sampler_snapshot = ?, seed = ?, model_identifier = ?,
            prior_context_hash = ?
        WHERE id = ?
        """,
        (
            n.parent_id,
            n.text,
            n.name,
            n.source,
            int(n.hidden),
            int(n.is_main_path),
            int(n.starred),
            json.dumps(n.sampler_snapshot) if n.sampler_snapshot is not None else None,
            n.seed,
            n.model_identifier,
            n.prior_context_hash,
            n.id,
        ),
    )


@router.post("/api/projects", response_model=ProjectInfo)
def create_project(data: CreateProjectRequest, request: Request) -> ProjectInfo:
    path = Path(data.path).expanduser().resolve()
    if path.exists():
        raise HTTPException(status_code=409, detail=f"Path already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    _close_current(request)
    conn = open_db(path)
    init_schema(conn)
    with conn:
        conn.execute(
            "INSERT INTO project_meta (key, value) VALUES (?, ?)", ("version", "1")
        )
        conn.execute(
            "INSERT INTO project_meta (key, value) VALUES (?, ?)",
            ("created_at", _now_iso()),
        )
        if data.title:
            conn.execute(
                "INSERT INTO project_meta (key, value) VALUES (?, ?)",
                ("title", data.title),
            )
        conn.execute(
            """
            INSERT INTO nodes (
                id, parent_id, text, name, source, hidden, is_main_path, created_at,
                prior_context_hash
            ) VALUES ('root', NULL, '', NULL, 'user_written', 0, 1, ?, ?)
            """,
            (_now_epoch(), "0" * 16),
        )
    request.app.state.conn = conn
    request.app.state.project_path = str(path)
    return _project_info(conn, str(path))


@router.post("/api/projects/open", response_model=ProjectInfo)
def open_project(data: OpenProjectRequest, request: Request) -> ProjectInfo:
    path = Path(data.path).expanduser().resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No such file: {path}")

    conn: sqlite3.Connection | None = None
    try:
        conn = open_db(path)
        init_schema(conn)
        _validate_project(conn)
        info = _project_info(conn, str(path))
    except HTTPException:
        if conn is not None:
            conn.close()
        raise
    except (OSError, sqlite3.Error) as ex:
        if conn is not None:
            conn.close()
        raise HTTPException(
            status_code=400, detail="Unable to open project file."
        ) from ex

    _close_current(request)
    request.app.state.conn = conn
    request.app.state.project_path = str(path)
    return info


@router.post("/api/projects/close")
def close_project(request: Request) -> dict[str, bool]:
    _close_current(request)
    return {"closed": True}


@router.get("/api/projects/current")
def current_project(request: Request) -> ProjectInfo | None:
    conn = getattr(request.app.state, "conn", None)
    path = getattr(request.app.state, "project_path", None)
    if conn is None or path is None:
        return None
    return _project_info(conn, path)


@router.get("/api/nodes", response_model=list[NodeModel])
def list_nodes(request: Request) -> list[NodeModel]:
    conn = _require_conn(request)
    rows = conn.execute("SELECT * FROM nodes").fetchall()
    return [_row_to_node(r) for r in rows]


@router.post("/api/nodes/batch")
def batch_mutate(data: MutationBatch, request: Request) -> dict[str, int]:
    conn = _require_conn(request)
    try:
        with conn:
            # Defer FK checks so creates can forward-reference each other
            conn.execute("PRAGMA defer_foreign_keys = ON")
            for n in data.creates:
                _insert_node(conn, n)
            for n in data.updates:
                _update_node(conn, n)
            for nid in data.deletes:
                conn.execute("DELETE FROM nodes WHERE id = ?", (nid,))
            if data.main_path is not None:
                conn.execute("UPDATE nodes SET is_main_path = 0")
                for nid in data.main_path:
                    conn.execute(
                        "UPDATE nodes SET is_main_path = 1 WHERE id = ?", (nid,)
                    )
    except sqlite3.IntegrityError as ex:
        raise HTTPException(status_code=409, detail=str(ex)) from ex
    return {
        "created": len(data.creates),
        "updated": len(data.updates),
        "deleted": len(data.deletes),
    }
