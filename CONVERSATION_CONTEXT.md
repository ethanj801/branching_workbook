# Branching Workbook Context Dump

Last updated: 2026-04-25

## Current State

- Repo: `/Users/EthanJ/Documents/github/branching_workbook`
- Git branch: `master`
- Phase status: **Phases 0-6 complete; Phase 7 polish started.** Next work is continuing the UI/open-project polish plus the optional RunPod fire-and-forget deployment track.
- Latest implementation commit before this handoff update: `aa0aca4` (`Polish workbook UI and persist node names`).
- Working tree at handoff-update time: documentation edits pending commit.

## What Is Implemented

### Client-side tree (phase 2)

- Pure TS LCP-split reducer in `client/src/tree/reshape.ts` with tests in `client/src/tree/reshape.test.ts`.
- `client/src/tree/persistence.ts` converts between in-memory `TreeNode` and wire `NodeModel`, and builds mutation batches from before/after tree pairs.
- Non-selected generated branches are hidden, not deleted.

### Project persistence (phase 2b)

- `server/bwbk/db.py` owns the per-project SQLite file.
- Nodes now have optional persisted `name` metadata. Existing `.bwbk` files are migrated by `init_schema()` with `ALTER TABLE nodes ADD COLUMN name TEXT`.
- Endpoints:
  - `POST /api/projects`
  - `POST /api/projects/open`
  - `POST /api/projects/close`
  - `GET /api/projects/current`
  - `GET /api/nodes`
  - `POST /api/nodes/batch`
- `user_preferences` no longer lives in the project DB. Project-local preference state such as `active_sampler_preset_id` lives in `project_meta`.

### Streaming + real Tabby passthrough (phases 1, 3, 4)

- `server/bwbk/mock.py` emits TabbyAPI-shaped SSE frames for offline dev/tests.
- `server/bwbk/proxy.py` forwards to real TabbyAPI when `BWBK_BACKEND=tabby`.
- `client/src/api.ts` has shared SSE parsing via `fetch` + `ReadableStream`.
- `/api/completions` is the single browser generation entrypoint.
- Fan-out is one `/v1/completions` request with `n > 1`; chunks are routed by `choices[i].index`.
- Important URL detail:
  - completions uses `BWBK_TABBY_COMPLETIONS_URL` exactly
  - other `/api/tabby/*` routes derive a base URL from `BWBK_TABBY_COMPLETIONS_URL` or `BWBK_TABBY_BASE_URL`
- That matters because the live setup used a tunnel on `127.0.0.1:5001`, not the default Tabby port.

### Model workflow (phase 5)

- Server wrapper routes:
  - `GET /api/tabby/model`
  - `GET /api/tabby/models`
  - `POST /api/tabby/model/load` (streamed)
  - `POST /api/tabby/model/unload`
  - `POST /api/tabby/download`
  - `POST /api/tabby/token/encode`
- Matching mock routes exist for offline work.
- `client/src/App.tsx` includes a model panel with:
  - current model
  - local model list
  - load/unload controls
  - Hugging Face download controls
  - debounced token/context budget via `/api/tabby/token/encode`
- Generate is disabled until a model is loaded.
- Generated nodes record the loaded model id in node metadata.

### Sampler presets (phase 6)

- Storage split:
  - user-global presets live in `~/Library/Application Support/bwbk/userdata.sqlite` on macOS via `platformdirs`; code in `server/bwbk/userdata.py`
  - active preset id is per-project in `project_meta` under `active_sampler_preset_id`
  - tests override the userdata path via `BWBK_USERDATA_DIR`
- Starter presets are seeded on first init:
  - Creative
  - Balanced
  - Deterministic
- Server endpoints in `server/bwbk/samplers.py`:
  - `GET /api/samplers/presets`
  - `POST /api/samplers/presets`
  - `PUT /api/samplers/presets/{id}`
  - `DELETE /api/samplers/presets/{id}`
  - `GET /api/samplers/active`
  - `PUT /api/samplers/active`
- Client sampler catalog in `client/src/samplers/fields.ts` mirrors the TabbyAPI subset we actually send.
- Deliberately excluded from the UI payload because TabbyAPI ignores or does not accept them in this path:
  - `seed`
  - `top_n_sigma`
  - `epsilon_cutoff`
  - `eta_cutoff`
  - `smoothing_curve`
- `mergePreset()` strips neutral-valued fields before generate so TabbyAPI defaults stand.
- `client/src/samplers/SamplerDrawer.tsx` is the right-side drawer with:
  - preset selector
  - Save
  - Save as
  - Delete
  - Neutralize
  - sectioned controls for Core / XTC / DRY / Penalties / Dynamic Temp / Smoothing / Misc
- `client/src/App.tsx` shows the active preset near Generate, includes a dirty `*`, and opens the drawer.
- Generate resolves the sampler snapshot up front, merges it into `/api/completions`, and persists it to `sampler_snapshot` on generated nodes.

### Phase 7 polish slice (latest)

- Commit `aa0aca4` started the real UI polish pass and added persisted node names.
- The dark dashboard layout was replaced with a mockup-aligned shell:
  - compact top model/status strip
  - left tree rail
  - central smooth manuscript buffer
  - bottom generate bar
  - right branch picker
  - model management moved into a modal
- Important course correction: do **not** continue the fake aged-paper / ruled-paper direction. The desired reference is `branching-workbook-mockup.jsx`: smooth `#f6f3ea` chrome, `#fbfaf5` editor, `#f2eee3` side rails, tiny uppercase labels, restrained borders, serif only for manuscript text and node title.
- Current node names are editable inline above the buffer and persist to SQLite. Tree labels prefer `node.name` and fall back to text preview.
- `client/src/samplers/SamplerDrawer.tsx` was restyled to match the light paper/stone UI, but it still needs a real browser pass.

## Verification

- `just check` is green:
  - `ruff check .`
  - server pytest
  - client vitest
  - client production build
- Current observed counts:
  - server tests: `39 passed`
  - client tests: `25 passed`

### Previously live-verified against the GPU tunnel

- SSH tunnel:
  - `127.0.0.1:5001 -> remote 127.0.0.1:5000`
  - command:

```bash
ssh -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  -i ~/.ssh/id_ed25519 \
  -p 20867 \
  -N \
  -L 5001:127.0.0.1:5000 \
  root@157.157.221.29
```

- Real Tabby checks succeeded through the tunnel:
  - `GET http://127.0.0.1:5001/v1/model`
  - `GET http://127.0.0.1:5001/v1/models`
  - `POST http://127.0.0.1:5001/v1/completions` with `n=2`
  - `POST http://127.0.0.1:5001/v1/token/encode`
- Wrapper checks also succeeded while local dev was running:
  - `GET http://127.0.0.1:8000/api/health`
  - `GET http://127.0.0.1:8000/api/tabby/model`
  - `GET http://127.0.0.1:8000/api/tabby/models`
  - `POST http://127.0.0.1:8000/api/tabby/token/encode`
  - `POST http://127.0.0.1:8000/api/completions` with `n=2`
- Observed remote model:
  - `google_gemma-3-270m-exl3`
  - revision `6.0bpw`
  - `max_seq_len=4096`
  - `cache_mode=Q6`

### Local runtime notes from the last working session

- Local dev command:

```bash
PATH=/opt/homebrew/bin:$PATH \
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions \
just dev
```

- FastAPI was serving on `http://127.0.0.1:8000`
- Vite was serving on `http://localhost:5173`
- Browser note:
  - `http://localhost:5173/` worked
  - `http://127.0.0.1:5173/` refused in this environment

## Docs Status

- `branching-workbook.md` reflects the two-store split and current Tabby workflow.
- `implementation-plan.md` records Phase 6 as implemented and Phase 7 as started with the mockup-aligned UI/node-name slice.
- `branching-workbook.md` now includes optional node `name` metadata in the node schema and buffer/tree UI requirements.
- `AGENTS.md` documents the durable backend assumptions, current manual test pod procedure, and the user-global vs project-local storage boundary.
- `CLAUDE.md` also reflects the two-store split in the current tree.

## Design Decisions That Matter

- Branching Workbook stays generic. It talks to the local FastAPI wrapper, not directly to RunPod-specific APIs.
- SSH is the recommended security boundary. Default workflow should not require copying Tabby API or admin keys.
- RunPod is disposable infrastructure, not a product dependency.
- GPU pods are treated as ephemeral. Model download and model load must be available in the UI.
- The project/userdata storage split is intentional:
  - confidential project folders must not leak project-identifying data into the global store
  - presets are cross-project
  - active-preset selection is project-local
- Tabby download behavior caveat:
  - current TabbyAPI behavior cancels a download if the request disconnects
  - the UI/docs should tell the user to keep the request open until download completes

## What Still Needs Doing

- Manual browser pass at `http://localhost:5173/` against real Tabby through the tunnel. Specifically validate:
  - model load/unload in the UI
  - model download in the UI
  - preset selection updates the draft
  - slider edits drive the dirty `*`
  - Save persists to the global userdata store
  - Save as creates a new preset
  - Delete clears the active preset when appropriate
  - Generate sends only non-neutral sampler fields and snapshots them on the new node
- Phase 7 polish:
  - continue matching `branching-workbook-mockup.jsx` proportions and smooth style
  - fix project open/create UX; current browser flow still requires typed filesystem paths and should get a native file picker or app-shell equivalent
  - browser-check inline node rename persistence
  - status indicators
  - full keyboard shortcut set
  - any remaining tree/branch UX cleanup
- RunPod fire-and-forget template:
  - still an optional infrastructure track
  - prefer an existing maintained image/template if it boots cleanly
  - otherwise build a small custom image/template that starts TabbyAPI on localhost and exposes SSH

## RunPod Fire-and-Forget Track

Goal:

- start a fresh GPU pod
- have TabbyAPI come up automatically
- bind TabbyAPI to `127.0.0.1:5000`
- expose SSH
- open one SSH tunnel from the laptop
- use the Branching Workbook UI for download/load/generate

What is known so far:

- RunPod templates support the knobs needed:
  - container image
  - exposed ports
  - environment variables
  - startup command
  - container disk
  - `/workspace` volume mounting
- Existing image family noted for validation:
  - `nschle/tabbyapi:*runpod`
- New optional helper assets now exist in `deploy/runpod/`:
  - `Dockerfile`
  - `runpod-entrypoint.sh`
  - `README.md`
- Current helper approach:
  - derive from `ghcr.io/theroyallab/tabbyapi:latest`
  - install `openssh-server` and `hf_transfer`
  - start `sshd`
  - write a minimal config to `/workspace/tabby-config/config.yml`
  - bind Tabby to `127.0.0.1:5000`
  - disable auth
  - use `/workspace/models` as `model_dir`
  - expose TCP `22` and tunnel to remote `127.0.0.1:5000`
- This helper is not live-validated on RunPod yet.
- No RunPod API automation should go into the product unless explicitly requested.

## Files Most Relevant

- `AGENTS.md`
- `branching-workbook.md`
- `implementation-plan.md`
- `CLAUDE.md`
- `server/bwbk/main.py`
- `server/bwbk/proxy.py`
- `server/bwbk/mock.py`
- `server/bwbk/db.py`
- `server/bwbk/samplers.py`
- `server/bwbk/userdata.py`
- `server/tests/test_samplers.py`
- `client/src/App.tsx`
- `client/src/api.ts`
- `client/src/tree/reshape.ts`
- `client/src/tree/persistence.ts`
- `client/src/samplers/fields.ts`
- `client/src/samplers/fields.test.ts`
- `client/src/samplers/SamplerDrawer.tsx`
- `deploy/runpod/Dockerfile`
- `deploy/runpod/runpod-entrypoint.sh`
- `deploy/runpod/README.md`

## Short Version

Phases 0-6 are in the tree and Phase 7 has started. `aa0aca4` moved the app toward the original mockup layout and added persisted, inline-editable node names. `just check` is green with 39 server tests and 25 client tests. Next: continue UI polish against `branching-workbook-mockup.jsx`, fix open/create project UX so users are not typing paths, do a real-browser pass against the live RunPod/Tabby tunnel, then decide whether to commit more polish or resume RunPod template validation.
