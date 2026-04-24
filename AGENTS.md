# AGENTS.md

Guidance for coding agents working in this repository.

## Durable Backend Assumptions

The finished product must be usable with an arbitrary GPU machine, not tied to
RunPod-specific APIs. Treat RunPod as one disposable-host setup guide, not as a
product dependency.

The intended inference boundary is:

1. The user starts a fresh GPU instance by whatever means they prefer.
2. The user runs TabbyAPI on that machine.
3. TabbyAPI binds to `127.0.0.1:5000` on the GPU machine.
4. TabbyAPI auth is disabled for the recommended SSH-tunnel workflow.
5. The user opens an SSH tunnel from the laptop:
   `ssh -N -L 5000:127.0.0.1:5000 user@host -p port`
6. Branching Workbook connects locally to `http://127.0.0.1:5000`.

SSH is the security boundary for the recommended workflow. Do not design around
persisting TabbyAPI API/admin keys as a required path. Support optional keys for
non-tunnel deployments, but the default path should require no copied TabbyAPI
keys.

Assume GPU pods are disposable. Do not assume downloaded models, generated
TabbyAPI keys, or other files on the pod survive across sessions. Model
download and model load must be available through the GUI in the final product.

The lightweight integration-test model is:

- Hugging Face repo: `lucyknada/google_gemma-3-270m-exl3`
- Required revision/branch: `6.0bpw`

## Current Manual Test Pod Procedure

For the current RunPod-style manual integration test, restart TabbyAPI with auth
disabled before testing Branching Workbook through the SSH tunnel:

```bash
cd /workspace/tabbyAPI
python - <<'PY'
from pathlib import Path

path = Path("config.yml")
text = path.read_text()
if "disable_auth:" in text:
    lines = [
        "disable_auth: true" if line.lstrip().startswith("disable_auth:") else line
        for line in text.splitlines()
    ]
    path.write_text("\n".join(lines) + "\n")
else:
    path.write_text(text.rstrip() + "\ndisable_auth: true\n")
PY
./start.sh
```

If the model is not present on a fresh pod, download it first:

```bash
cd /workspace/tabbyAPI
./start.sh download lucyknada/google_gemma-3-270m-exl3 --revision 6.0bpw
```

Once TabbyAPI is running, load the model:

```bash
curl -N http://127.0.0.1:5000/v1/model/load \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "google_gemma-3-270m-exl3",
    "max_seq_len": 4096,
    "cache_mode": "Q6"
  }'
```

From the laptop, open the tunnel:

```bash
ssh -N -L 5000:127.0.0.1:5000 root@<pod-ip> -p <ssh-port> -i ~/.ssh/id_ed25519
```

Then run the local app against the real backend:

```bash
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5000/v1/completions \
PATH=/opt/homebrew/bin:$PATH \
just dev
```

Do not put RunPod API automation in the product unless explicitly requested.

## User-Global vs Project-Local Storage

Two SQLite stores, deliberately separate:

- **Project files (`.bwbk`)** — per-project, user picks the path. May live in a confidential folder. Contains `project_meta`, `nodes`. Per-project state like "which sampler preset is active" goes in `project_meta` under a well-known key (`active_sampler_preset_id`). See `server/bwbk/db.py`.
- **User-global store (`userdata.sqlite`)** — cross-project. Resolved via `platformdirs` (`~/Library/Application Support/bwbk/userdata.sqlite` on macOS). Contains `sampler_presets`, `settings`. See `server/bwbk/userdata.py`. Tests override via `BWBK_USERDATA_DIR`.

Never write project paths, project titles, or any project-identifying state into the user-global store — confidential projects must stay confined to their own folder. If a future feature (e.g. "recent projects") would cross this boundary, keep it opt-in per project.
