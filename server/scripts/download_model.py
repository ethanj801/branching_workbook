"""Download the local backend's GGUF model into server/models/.

The model spec (REPO_ID, FILENAME, MODEL_DIR) lives in bwbk.local, so changing the model
is a one-place edit there and re-running this script. Needs the `local` optional group
(`uv sync --extra local`).

    uv run --extra local python scripts/download_model.py
"""

import sys
from pathlib import Path

# Put the server root on sys.path so `bwbk` imports when this file is run as a script.
# Python puts the script's own dir (scripts/) on the path, not the server root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from huggingface_hub import hf_hub_download  # noqa: E402

from bwbk.local import FILENAME, MODEL_DIR, REPO_ID  # noqa: E402


def main() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {REPO_ID}/{FILENAME} into {MODEL_DIR}")
    path = hf_hub_download(repo_id=REPO_ID, filename=FILENAME, local_dir=str(MODEL_DIR))
    print(f"Saved {path}")


if __name__ == "__main__":
    main()
