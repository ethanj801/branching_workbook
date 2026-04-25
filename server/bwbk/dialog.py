"""Native OS file dialogs for the project open/create flow.

The local FastAPI wrapper is the only thing in the system that may invoke
these dialogs. The browser cannot show a real filesystem picker, and we
will not ship a recents list, MRU cache, or any other persisted record of
project paths. The dialog chooses a path, the endpoint hands it back in
the response body, and that is the entirety of the write surface for
filesystem identity. Confidential project folders are the reason: nothing
in this module may log, persist, or remember a path beyond the current
request/response.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()


_OPEN_SCRIPT = (
    'set chosen to choose file '
    'with prompt "Open Branching Workbook project (.bwbk)"\n'
    "POSIX path of chosen"
)

_CREATE_SCRIPT = (
    'set chosen to choose file name '
    'with prompt "Save new Branching Workbook project as..." '
    'default name "workbook.bwbk"\n'
    "POSIX path of chosen"
)


def _run_osascript(script: str) -> str | None:
    """Run an AppleScript snippet. Returns the chosen POSIX path, or None
    if the user cancelled the dialog. Never logs the path.
    """
    if sys.platform != "darwin":
        raise HTTPException(
            status_code=501,
            detail="Native file dialog is only implemented on macOS.",
        )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as ex:
        raise HTTPException(
            status_code=500, detail="osascript is not available on this system."
        ) from ex
    if result.returncode != 0:
        return None
    chosen = result.stdout.strip()
    return chosen or None


@router.post("/api/projects/dialog/open")
def dialog_open() -> dict[str, str | None]:
    return {"path": _run_osascript(_OPEN_SCRIPT)}


@router.post("/api/projects/dialog/create")
def dialog_create() -> dict[str, str | None]:
    chosen = _run_osascript(_CREATE_SCRIPT)
    if chosen is None:
        return {"path": None}
    p = Path(chosen)
    if p.suffix.lower() != ".bwbk":
        # Preserve any extension the user explicitly typed by appending,
        # not replacing — `notes.txt` becomes `notes.txt.bwbk` rather
        # than silently dropping their intent.
        p = Path(str(p) + ".bwbk")
    return {"path": str(p)}
