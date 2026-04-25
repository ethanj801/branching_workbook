"""Tests for SQLite persistence + project lifecycle (phase 2b).

Server is intentionally dumb about trees here: we're verifying that the wire
shape a reshape produces (creates / updates / deletes / main_path) round-trips
through SQLite atomically, and that opening/closing/switching projects does
the right thing with shared FastAPI app state.
"""

import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from bwbk.main import app


@pytest.fixture(autouse=True)
def reset_app_state():
    """Each test starts with no project open — app.state is module-global."""
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
def project_path():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d) / "test.bwbk"


def _mk(
    id: str,
    parent_id: str | None,
    text: str,
    **overrides,
) -> dict:
    base = {
        "id": id,
        "parent_id": parent_id,
        "text": text,
        "source": "user_written",
        "hidden": False,
        "is_main_path": True,
        "created_at": 1000,
        "prior_context_hash": "0" * 16,
    }
    base.update(overrides)
    return base


async def test_no_project_open_returns_409(client: AsyncClient):
    r = await client.get("/api/nodes")
    assert r.status_code == 409
    assert (await client.get("/api/projects/current")).json() is None


async def test_create_project_initializes_schema_and_root(
    client: AsyncClient, project_path: Path
):
    r = await client.post(
        "/api/projects", json={"path": str(project_path), "title": "Test"}
    )
    assert r.status_code == 200
    info = r.json()
    assert info["path"].endswith("test.bwbk")
    assert info["title"] == "Test"
    assert info["version"] == "1"
    assert info["created_at"] is not None
    assert project_path.exists()

    nodes = (await client.get("/api/nodes")).json()
    assert len(nodes) == 1
    root = nodes[0]
    assert root["id"] == "root"
    assert root["parent_id"] is None
    assert root["is_main_path"] is True


async def test_create_refuses_existing_path(
    client: AsyncClient, project_path: Path
):
    await client.post("/api/projects", json={"path": str(project_path)})
    r = await client.post("/api/projects", json={"path": str(project_path)})
    assert r.status_code == 409


async def test_open_existing_project(client: AsyncClient, project_path: Path):
    await client.post(
        "/api/projects", json={"path": str(project_path), "title": "X"}
    )
    await client.post("/api/projects/close")
    assert (await client.get("/api/projects/current")).json() is None

    r = await client.post(
        "/api/projects/open", json={"path": str(project_path)}
    )
    assert r.status_code == 200
    assert r.json()["title"] == "X"


async def test_open_missing_path_404(client: AsyncClient):
    r = await client.post(
        "/api/projects/open", json={"path": "/nonexistent/path.bwbk"}
    )
    assert r.status_code == 404


async def test_open_rejects_empty_non_project_file(client: AsyncClient, project_path: Path):
    project_path.write_bytes(b"")

    r = await client.post("/api/projects/open", json={"path": str(project_path)})

    assert r.status_code == 400
    assert (await client.get("/api/projects/current")).json() is None


async def test_failed_open_keeps_current_project(client: AsyncClient):
    with tempfile.TemporaryDirectory() as d:
        good_path = Path(d) / "good.bwbk"
        bad_path = Path(d) / "bad.bwbk"
        bad_path.write_text("not sqlite")

        await client.post(
            "/api/projects", json={"path": str(good_path), "title": "Good"}
        )
        r = await client.post("/api/projects/open", json={"path": str(bad_path)})

        assert r.status_code == 400
        current = (await client.get("/api/projects/current")).json()
        assert current["path"] == str(good_path.resolve())
        assert current["title"] == "Good"
        nodes = (await client.get("/api/nodes")).json()
        assert [node["id"] for node in nodes] == ["root"]


async def test_batch_creates_forward_references(
    client: AsyncClient, project_path: Path
):
    """A reshape can emit creates where a child forward-references a sibling
    created in the same batch — defer_foreign_keys must allow this."""
    await client.post("/api/projects", json={"path": str(project_path)})
    # A and B created in one batch; B references A; A references existing root.
    a = _mk("A", "root", "hello ")
    b = _mk("B", "A", "world")

    r = await client.post(
        "/api/nodes/batch",
        json={"creates": [a, b], "main_path": ["root", "A", "B"]},
    )
    assert r.status_code == 200
    assert r.json() == {"created": 2, "updated": 0, "deleted": 0}

    nodes = {n["id"]: n for n in (await client.get("/api/nodes")).json()}
    assert set(nodes) == {"root", "A", "B"}
    assert nodes["A"]["parent_id"] == "root"
    assert nodes["B"]["parent_id"] == "A"
    # is_main_path updated only for root, A, B
    assert nodes["A"]["is_main_path"] is True
    assert nodes["B"]["is_main_path"] is True


async def test_batch_updates_and_deletes(
    client: AsyncClient, project_path: Path
):
    await client.post("/api/projects", json={"path": str(project_path)})
    a = _mk("A", "root", "hi")
    b = _mk("B", "A", "there")
    await client.post("/api/nodes/batch", json={"creates": [a, b]})

    # Update A's text, delete B
    a_updated = _mk("A", "root", "hello")
    r = await client.post(
        "/api/nodes/batch",
        json={"updates": [a_updated], "deletes": ["B"]},
    )
    assert r.status_code == 200

    nodes = {n["id"]: n for n in (await client.get("/api/nodes")).json()}
    assert set(nodes) == {"root", "A"}
    assert nodes["A"]["text"] == "hello"


async def test_node_name_roundtrip(client: AsyncClient, project_path: Path):
    await client.post("/api/projects", json={"path": str(project_path)})
    a = _mk("A", "root", "chapter text", name="Chapter One")

    r = await client.post("/api/nodes/batch", json={"creates": [a]})
    assert r.status_code == 200

    fetched = next(
        node for node in (await client.get("/api/nodes")).json() if node["id"] == "A"
    )
    assert fetched["name"] == "Chapter One"


async def test_batch_main_path_flag_is_exclusive(
    client: AsyncClient, project_path: Path
):
    """Sending main_path=[x, y, z] should clear is_main_path everywhere else."""
    await client.post("/api/projects", json={"path": str(project_path)})
    a = _mk("A", "root", "a")
    b = _mk("B", "A", "b")
    c = _mk("C", "A", "c", is_main_path=False)
    await client.post(
        "/api/nodes/batch",
        json={"creates": [a, b, c], "main_path": ["root", "A", "B"]},
    )
    # Now switch main_path to C
    await client.post("/api/nodes/batch", json={"main_path": ["root", "A", "C"]})
    nodes = {n["id"]: n for n in (await client.get("/api/nodes")).json()}
    assert nodes["root"]["is_main_path"] is True
    assert nodes["A"]["is_main_path"] is True
    assert nodes["B"]["is_main_path"] is False
    assert nodes["C"]["is_main_path"] is True


async def test_batch_rolls_back_on_integrity_error(
    client: AsyncClient, project_path: Path
):
    """If any create in the batch violates a constraint, no creates persist."""
    await client.post("/api/projects", json={"path": str(project_path)})
    a = _mk("A", "root", "ok")
    await client.post("/api/nodes/batch", json={"creates": [a]})
    # Now attempt to create B + re-create A (duplicate PK). Whole batch should roll back.
    b = _mk("B", "A", "also ok")
    r = await client.post("/api/nodes/batch", json={"creates": [b, a]})
    assert r.status_code >= 400
    # B must not exist — atomicity
    nodes = {n["id"] for n in (await client.get("/api/nodes")).json()}
    assert "B" not in nodes


async def test_sampler_snapshot_json_roundtrip(
    client: AsyncClient, project_path: Path
):
    await client.post("/api/projects", json={"path": str(project_path)})
    sampler = {"temperature": 0.9, "top_p": 0.95, "min_p": 0.02}
    n = _mk(
        "G",
        "root",
        "g",
        source="generated",
        sampler_snapshot=sampler,
        seed=42,
        model_identifier="mock",
    )
    await client.post("/api/nodes/batch", json={"creates": [n]})
    fetched = next(
        x for x in (await client.get("/api/nodes")).json() if x["id"] == "G"
    )
    assert fetched["sampler_snapshot"] == sampler
    assert fetched["seed"] == 42
    assert fetched["model_identifier"] == "mock"
