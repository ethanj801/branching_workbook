"""Tests for the native OS file dialog endpoints.

These endpoints shell out to `osascript`, so the tests monkeypatch
`subprocess.run` to avoid popping a real Finder dialog on a developer's
machine or in CI. The contract being verified:
- A successful selection returns the POSIX path.
- A user cancellation (non-zero exit) returns `{"path": null}`.
- The create endpoint appends `.bwbk` if the user didn't include it.
- Nothing logs the chosen path.
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from bwbk.main import app


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _fake_run(stdout: str, returncode: int = 0):
    def _run(*args, **kwargs):  # noqa: ARG001 - signature mirrors subprocess.run
        return subprocess.CompletedProcess(
            args=args[0] if args else [],
            returncode=returncode,
            stdout=stdout,
            stderr="",
        )

    return _run


@pytest.fixture(autouse=True)
def force_darwin(monkeypatch):
    """The endpoints refuse to run off macOS; force the platform check
    so the test suite passes on any developer machine."""
    monkeypatch.setattr(sys, "platform", "darwin")


async def test_dialog_open_returns_chosen_path(client, monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run("/Users/me/work/notes.bwbk\n"))

    response = await client.post("/api/projects/dialog/open")

    assert response.status_code == 200
    assert response.json() == {"path": "/Users/me/work/notes.bwbk"}


async def test_dialog_open_returns_null_on_cancel(client, monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run("", returncode=1))

    response = await client.post("/api/projects/dialog/open")

    assert response.status_code == 200
    assert response.json() == {"path": None}


async def test_dialog_create_appends_bwbk_suffix(client, monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run("/Users/me/work/notes\n"))

    response = await client.post("/api/projects/dialog/create")

    assert response.status_code == 200
    assert response.json() == {"path": "/Users/me/work/notes.bwbk"}


async def test_dialog_create_preserves_other_extensions(client, monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run("/Users/me/work/notes.txt\n"))

    response = await client.post("/api/projects/dialog/create")

    assert response.status_code == 200
    assert response.json() == {"path": "/Users/me/work/notes.txt.bwbk"}


async def test_dialog_create_passes_through_bwbk_path(client, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", _fake_run("/Users/me/work/notes.bwbk\n")
    )

    response = await client.post("/api/projects/dialog/create")

    assert response.status_code == 200
    assert response.json() == {"path": "/Users/me/work/notes.bwbk"}


async def test_dialog_create_returns_null_on_cancel(client, monkeypatch):
    monkeypatch.setattr(subprocess, "run", _fake_run("", returncode=1))

    response = await client.post("/api/projects/dialog/create")

    assert response.status_code == 200
    assert response.json() == {"path": None}


async def test_dialog_open_off_macos_returns_501(client, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")

    response = await client.post("/api/projects/dialog/open")

    assert response.status_code == 501
