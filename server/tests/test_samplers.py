"""Tests for user-global sampler preset CRUD + per-project active preset.

Presets live in `userdata.sqlite`; active preset id lives in the project's
`project_meta`. Fixture points `BWBK_USERDATA_DIR` at a tmp dir so tests
don't touch the real user data.
"""

import os
import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from bwbk import userdata
from bwbk.main import app


@pytest.fixture(autouse=True)
def reset_app_state() -> Iterator[None]:
    if getattr(app.state, "conn", None) is not None:
        app.state.conn.close()
        delattr(app.state, "conn")
    if hasattr(app.state, "project_path"):
        delattr(app.state, "project_path")
    yield
    if getattr(app.state, "conn", None) is not None:
        app.state.conn.close()
        delattr(app.state, "conn")


@pytest.fixture(autouse=True)
def isolated_userdata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Redirect the userdata store to a tmp dir so seeding is fresh per test."""
    monkeypatch.setenv("BWBK_USERDATA_DIR", str(tmp_path / "userdata"))
    userdata.reset_for_tests()
    yield tmp_path / "userdata"
    userdata.reset_for_tests()


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def project_path() -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as d:
        yield Path(d) / "test.bwbk"


async def _open_project(client: AsyncClient, project_path: Path) -> None:
    r = await client.post("/api/projects", json={"path": str(project_path)})
    assert r.status_code == 200


async def test_list_returns_seeded_starters(client: AsyncClient):
    r = await client.get("/api/samplers/presets")
    assert r.status_code == 200
    presets = r.json()
    names = {p["name"] for p in presets}
    assert {"Creative", "Balanced", "Deterministic"} <= names
    assert all(p["is_starter"] for p in presets if p["name"] in names)
    # Starters first, then alphabetical.
    assert presets[0]["is_starter"] is True


async def test_create_update_delete_round_trip(client: AsyncClient):
    created = await client.post(
        "/api/samplers/presets",
        json={"name": "Wild", "body": {"temperature": 1.4, "min_p": 0.02}},
    )
    assert created.status_code == 200
    preset_id = created.json()["id"]
    assert created.json()["is_starter"] is False
    assert created.json()["body"]["temperature"] == 1.4

    # Update body; name left alone.
    updated = await client.put(
        f"/api/samplers/presets/{preset_id}",
        json={"body": {"temperature": 1.2, "xtc_probability": 0.3}},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Wild"
    assert updated.json()["body"] == {"temperature": 1.2, "xtc_probability": 0.3}
    assert updated.json()["updated_at"] >= updated.json()["created_at"]

    # Rename.
    renamed = await client.put(
        f"/api/samplers/presets/{preset_id}", json={"name": "Wilder"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Wilder"

    deleted = await client.delete(f"/api/samplers/presets/{preset_id}")
    assert deleted.status_code == 200
    gone = await client.get("/api/samplers/presets")
    assert all(p["id"] != preset_id for p in gone.json())


async def test_create_rejects_duplicate_name(client: AsyncClient):
    first = await client.post(
        "/api/samplers/presets", json={"name": "One", "body": {}}
    )
    assert first.status_code == 200
    dup = await client.post("/api/samplers/presets", json={"name": "One", "body": {}})
    assert dup.status_code == 409


async def test_body_preserves_arbitrary_fields(client: AsyncClient):
    """Unknown keys survive round-trip — forward-compat with future TabbyAPI samplers."""
    r = await client.post(
        "/api/samplers/presets",
        json={
            "name": "Future",
            "body": {"temperature": 1.0, "some_future_param": {"nested": [1, 2]}},
        },
    )
    assert r.status_code == 200
    fetched = next(
        p for p in (await client.get("/api/samplers/presets")).json()
        if p["name"] == "Future"
    )
    assert fetched["body"]["some_future_param"] == {"nested": [1, 2]}


async def test_update_missing_id_404(client: AsyncClient):
    r = await client.put(
        "/api/samplers/presets/does-not-exist", json={"name": "x"}
    )
    assert r.status_code == 404


async def test_delete_missing_id_404(client: AsyncClient):
    r = await client.delete("/api/samplers/presets/does-not-exist")
    assert r.status_code == 404


async def test_active_requires_project_open(client: AsyncClient):
    r = await client.get("/api/samplers/active")
    assert r.status_code == 409
    r = await client.put("/api/samplers/active", json={"preset_id": None})
    assert r.status_code == 409


async def test_active_preset_set_and_get(client: AsyncClient, project_path: Path):
    await _open_project(client, project_path)
    # default: nothing active
    r = await client.get("/api/samplers/active")
    assert r.status_code == 200
    assert r.json()["preset_id"] is None

    # pick a starter
    starter = (await client.get("/api/samplers/presets")).json()[0]
    set_r = await client.put(
        "/api/samplers/active", json={"preset_id": starter["id"]}
    )
    assert set_r.status_code == 200
    assert set_r.json()["preset_id"] == starter["id"]

    # round-trip
    got = await client.get("/api/samplers/active")
    assert got.json()["preset_id"] == starter["id"]

    # clear
    cleared = await client.put("/api/samplers/active", json={"preset_id": None})
    assert cleared.json()["preset_id"] is None


async def test_active_rejects_unknown_preset_id(
    client: AsyncClient, project_path: Path
):
    await _open_project(client, project_path)
    r = await client.put(
        "/api/samplers/active", json={"preset_id": "not-a-real-id"}
    )
    assert r.status_code == 404


async def test_active_preset_survives_reopen(
    client: AsyncClient, project_path: Path
):
    """Active preset id is stored in project_meta, so closing/reopening keeps it."""
    await _open_project(client, project_path)
    starter = (await client.get("/api/samplers/presets")).json()[0]
    await client.put("/api/samplers/active", json={"preset_id": starter["id"]})

    await client.post("/api/projects/close")
    await client.post("/api/projects/open", json={"path": str(project_path)})

    got = await client.get("/api/samplers/active")
    assert got.json()["preset_id"] == starter["id"]


async def test_starters_not_reseeded_after_delete(client: AsyncClient):
    """Deleting a starter should be durable — seeding is gated by is_starter count."""
    presets = (await client.get("/api/samplers/presets")).json()
    creative = next(p for p in presets if p["name"] == "Creative")
    await client.delete(f"/api/samplers/presets/{creative['id']}")

    # Force userdata re-init by dropping the cached conn.
    userdata.reset_for_tests()
    assert os.getenv("BWBK_USERDATA_DIR")  # sanity

    remaining = {p["name"] for p in (await client.get("/api/samplers/presets")).json()}
    assert "Creative" not in remaining
    assert {"Balanced", "Deterministic"} <= remaining
