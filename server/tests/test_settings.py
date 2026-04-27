"""Tests for per-project UI settings stored in project_meta."""

import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

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


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def project_path() -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as d:
        yield Path(d) / "settings.bwbk"


async def _open_project(client: AsyncClient, project_path: Path) -> None:
    r = await client.post("/api/projects", json={"path": str(project_path)})
    assert r.status_code == 200


async def test_settings_require_open_project(client: AsyncClient):
    assert (await client.get("/api/project/settings")).status_code == 409
    assert (
        await client.put("/api/project/settings", json={"display_mode": "inline"})
    ).status_code == 409


async def test_settings_defaults_and_round_trip(
    client: AsyncClient, project_path: Path
):
    await _open_project(client, project_path)

    defaults = await client.get("/api/project/settings")
    assert defaults.status_code == 200
    assert defaults.json() == {
        "display_mode": "cards",
        "branch_count": 3,
        "max_tokens": 256,
        "tokens_per_suggestion": 2,
    }

    updated = await client.put(
        "/api/project/settings",
        json={
            "display_mode": "inline",
            "branch_count": 5,
            "max_tokens": 512,
            "tokens_per_suggestion": 4,
        },
    )
    assert updated.status_code == 200
    assert updated.json() == {
        "display_mode": "inline",
        "branch_count": 5,
        "max_tokens": 512,
        "tokens_per_suggestion": 4,
    }

    await client.post("/api/projects/close")
    await client.post("/api/projects/open", json={"path": str(project_path)})
    reopened = await client.get("/api/project/settings")
    assert reopened.json() == updated.json()


async def test_settings_patch_preserves_other_values(
    client: AsyncClient, project_path: Path
):
    await _open_project(client, project_path)
    await client.put(
        "/api/project/settings",
        json={"display_mode": "inline", "branch_count": 7},
    )

    patched = await client.put("/api/project/settings", json={"max_tokens": 100})
    assert patched.status_code == 200
    assert patched.json()["display_mode"] == "inline"
    assert patched.json()["branch_count"] == 7
    assert patched.json()["max_tokens"] == 100


async def test_settings_validate_bounds(client: AsyncClient, project_path: Path):
    await _open_project(client, project_path)
    assert (
        await client.put("/api/project/settings", json={"branch_count": 0})
    ).status_code == 422
    assert (
        await client.put("/api/project/settings", json={"tokens_per_suggestion": 9})
    ).status_code == 422
    assert (
        await client.put("/api/project/settings", json={"display_mode": "chat"})
    ).status_code == 422
