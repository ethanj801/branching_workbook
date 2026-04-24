"""User-global preferences store (separate from per-project `.bwbk` files).

Projects live wherever the user chose to put them — some folders are
confidential, so nothing user-global is ever written into a project DB.
This module owns a single SQLite file under the platform's app-support
directory (via `platformdirs`) that holds sampler presets and other
cross-project settings.

Layout:
    ~/Library/Application Support/bwbk/userdata.sqlite   (macOS)
    ~/.local/share/bwbk/userdata.sqlite                  (Linux / XDG)
    %LOCALAPPDATA%\\bwbk\\userdata.sqlite                (Windows)

Override for tests / portability via the `BWBK_USERDATA_DIR` env var.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import sqlite3
import uuid
from pathlib import Path

from platformdirs import user_data_dir

USERDATA_SCHEMA = """
CREATE TABLE IF NOT EXISTS sampler_presets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    body        TEXT NOT NULL,
    is_starter  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

# Starter preset bodies. Field names match TabbyAPI's `BaseSamplerRequest`
# canonical names (not ooba aliases): `typical_p` is sent as `typical`, rep
# penalty range as `penalty_range`, etc. Anything not in TabbyAPI's schema is
# omitted so the payload stays strictly valid.
STARTER_PRESETS: list[tuple[str, dict]] = [
    (
        "Creative",
        {
            "temperature": 1.0,
            "min_p": 0.02,
            "xtc_threshold": 0.1,
            "xtc_probability": 0.5,
            "dry_multiplier": 0.8,
            "dry_base": 1.75,
            "dry_allowed_length": 2,
            "repetition_penalty": 1.0,
            "max_tokens": 256,
        },
    ),
    (
        "Balanced",
        {
            "temperature": 0.9,
            "top_p": 0.95,
            "min_p": 0.05,
            "repetition_penalty": 1.05,
            "max_tokens": 256,
        },
    ),
    (
        "Deterministic",
        {
            "temperature": 0.1,
            "top_k": 1,
            "repetition_penalty": 1.0,
            "max_tokens": 256,
        },
    ),
]


def _now_iso() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")


def userdata_dir() -> Path:
    """Resolve the on-disk directory for the user-global SQLite file.

    `BWBK_USERDATA_DIR` lets tests point somewhere ephemeral; production runs
    use `platformdirs` which gives the right macOS / Linux / Windows path.
    """
    override = os.getenv("BWBK_USERDATA_DIR")
    if override:
        return Path(override).expanduser()
    return Path(user_data_dir("bwbk", appauthor=False))


def userdata_path() -> Path:
    return userdata_dir() / "userdata.sqlite"


def open_userdata() -> sqlite3.Connection:
    path = userdata_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI sync handlers run on a threadpool, same
    # as `db.open_db`.
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_userdata(conn: sqlite3.Connection) -> None:
    with conn:
        conn.executescript(USERDATA_SCHEMA)
    _seed_starters(conn)


def _seed_starters(conn: sqlite3.Connection) -> None:
    """Install the 3 starter presets the first time userdata is created.

    Keyed off `is_starter = 1` so re-running init after the user renames or
    deletes a starter doesn't resurrect it.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM sampler_presets WHERE is_starter = 1"
    ).fetchone()
    if row["n"] > 0:
        return
    now = _now_iso()
    with conn:
        for name, body in STARTER_PRESETS:
            conn.execute(
                """
                INSERT OR IGNORE INTO sampler_presets (
                    id, name, body, is_starter, created_at, updated_at
                ) VALUES (?, ?, ?, 1, ?, ?)
                """,
                (str(uuid.uuid4()), name, json.dumps(body), now, now),
            )


# --- cached singleton connection ------------------------------------------


_conn: sqlite3.Connection | None = None


def get_conn() -> sqlite3.Connection:
    """Return the process-wide userdata connection, opening + seeding on first call."""
    global _conn
    if _conn is None:
        _conn = open_userdata()
        init_userdata(_conn)
    return _conn


def reset_for_tests() -> None:
    """Drop the cached connection so the next `get_conn()` re-reads the env var."""
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None
