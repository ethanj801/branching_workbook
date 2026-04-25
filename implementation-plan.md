# Implementation Plan

Companion to `branching-workbook.md`. The spec says *what*; this says *in what order*.

## Guiding principles

- **Thin vertical slices.** Each phase produces something runnable, not a wiring diagram. Never more than a few days of work before the app does something new end-to-end.
- **Mock for local development, real GPU for integration.** ExLlamaV3 is CUDA-only. Phases 1–3 ran against a mock SSE server in the FastAPI wrapper. The mock remains useful for tests and offline UI work, but the product path is now the real TabbyAPI workflow through an SSH tunnel.
- **Mock format is not invented.** To kill the mock-vs-real drift risk, the mock's SSE chunks are copied byte-for-byte from TabbyAPI's actual completions handler (sibling checkout at `../tabbyAPI`). Same `data: {...}\n\n` framing, same `[DONE]` terminator, same `choices[i].index` placement, same trailing `usage` chunk. The mock is TabbyAPI-shaped with canned content.
- **Server is stateless wrt user work (§6.2).** The wrapper owns filesystem + SQLite + TabbyAPI proxy. It does *not* own the tree algorithm. All tree reshaping (§3.1 LCP split) is a pure client-side TS reducer; the server persists the resulting node diffs transactionally. This matches the spec's statelessness stance and makes later Electron/Tauri wrapping trivial.
- **Port from the mockup, don't import it.** `branching-workbook-mockup.jsx` is a shape reference. `commitBranchToBuffer` and `TreeNode` are worth reading before writing the real equivalents — the structure is close, but the mockup skips ancestor-splitting and has no hash tracking. Spec wins ties.

## Stack (decided)

- **Backend wrapper:** FastAPI + `uvicorn` + `httpx` (async SSE proxy), `sqlite3` stdlib, Python 3.11+.
- **Frontend:** React + TypeScript + Vite. Tailwind for styling (matches the mockup). Vitest for unit tests of the tree algorithm.
- **Dev proxy:** Vite `server.proxy` routes `/api/*` to FastAPI. Same-origin in dev and prod — no CORS setup, no EventSource-with-credentials quirks.
- **Top-level orchestration:** `justfile` at repo root. `just dev` runs FastAPI and Vite in parallel.
- **Inference:** TabbyAPI on a GPU host, reached through an SSH tunnel to a local laptop port. The wrapper derives the Tabby base URL from `BWBK_TABBY_COMPLETIONS_URL` or accepts `BWBK_TABBY_BASE_URL`.
- **Storage:** SQLite `.bwbk` files, schema per §8.2.
- **Tokenization:** server-side via TabbyAPI's `/v1/token/encode`, debounced in the client and surfaced as a context-budget readout.

## Repo layout (target)

```
branching_workbook/
├── justfile                 # dev / build / test
├── server/                  # FastAPI wrapper
│   ├── pyproject.toml
│   └── bwbk/
│       ├── main.py          # app, route wiring, Vite static serving in prod
│       ├── db.py            # sqlite: open/create .bwbk, node CRUD (dumb persistence)
│       ├── mock.py          # TabbyAPI-shaped canned SSE for dev
│       └── proxy.py         # real TabbyAPI passthrough: SSE streaming + cancellation
├── client/                  # Vite + React + TS
│   ├── package.json
│   ├── vite.config.ts       # server.proxy → localhost:8000
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── tree/            # §3.1 LCP split algorithm (pure functions)
│       │   ├── reshape.ts   # buffer + activePath → node mutations
│       │   ├── hash.ts      # xxhash3-64 for prior_context_hash
│       │   └── reshape.test.ts
│       ├── state/           # reducer: nodes, mainPath, buffer, currentId
│       ├── components/      # TreeNode, BranchPanel, ModelBar, etc.
│       └── api.ts           # SSE + fetch helpers
├── branching-workbook.md
├── branching-workbook-mockup.jsx
├── implementation-plan.md   (this file)
└── CLAUDE.md
```

## Phasing

### Phase 0 — Scaffolding

- First commit: spec, mockup, CLAUDE.md, this plan.
- `server/`: `pyproject.toml` (fastapi, uvicorn, httpx). `bwbk/main.py` with a `/api/health` route.
- `client/`: `npm create vite@latest` (React+TS), add Tailwind, delete boilerplate. `vite.config.ts` proxies `/api/*` → `http://localhost:8000`.
- Root `justfile`: `just dev` runs both processes in parallel.
- Deliverable: `just dev`, open `localhost:5173`, see "ok" from `/api/health`.

### Phase 1 — Mock streaming into a single textarea

- `server/bwbk/mock.py`: `POST /api/completions` streams SSE chunks copied verbatim from TabbyAPI's format. Respect `stream: true`, emit `index=0` only for now. Configurable delay between chunks. Honor client disconnect (cooperative cancellation).
- `client/src/api.ts`: `fetch` + `ReadableStream` parser for SSE (EventSource doesn't support POST bodies). Dispatches per-`index` chunks to a handler.
- Client UI: one big textarea for the buffer, "generate" button fires a completion, single append-only panel shows streaming text, "commit" pastes the panel into the buffer. No tree, no SQLite.
- **Proves:** transport plumbing, SSE parsing, cooperative cancellation on disconnect.

### Phase 2 — Tree algorithm + SQLite persistence

This is the load-bearing phase. Tree reshaping and persistence land together — can't build one without the other.

- `client/src/tree/reshape.ts`: pure TS function implementing the §3.1 algorithm. Inputs: `buffer`, `activePath` (list of nodes with text), existing sibling tree. Output: a list of node mutations (`create`, `split`, `hide`, `reparent`). No IO, fully deterministic.
- `client/src/tree/hash.ts`: xxhash3-64 over root-to-parent text. Computed and stored on every new node (`prior_context_hash` per §3.3). Used later for stale-ancestor UI affordances when an ancestor is edited.
- `client/src/tree/reshape.test.ts` (Vitest), with these fixtures at minimum:
  - `test_pure_append` — append at end of active leaf
  - `test_edit_inside_ancestor` — §3.1's "cat sat on the mat" → "chair" case
  - `test_delete_into_ancestor` — delete back through multiple nodes
  - `test_edit_recreates_sibling` — reattach to existing hidden branch
  - `test_paste_replaces_whole_buffer` — LCP is empty
  - `test_no_op_edit` — buffer == activePath
- `server/bwbk/db.py`: §8.2 schema. Endpoints: `POST /api/projects` (create), `POST /api/projects/open`, `GET/POST/PATCH /api/nodes`. Transactional batch write for a mutation list. Server is pure persistence — no §3.1 logic here.
- Client: "Open project" / "New project" dialog; `currentProjectPath` in state. Full in-memory tree from the mockup's `App` reducer, ported to TS. `TreeNode` component ported with types.
- "Save" keybinding (Cmd/Ctrl+S) triggers commit — this is a §3.1 trigger per §7.2, not Phase 7 polish.
- **Proves:** the load-bearing concept, with persistence across restarts. All downstream phases depend on this.

### Phase 3 — Fan-out picker

- Mock server: respect `n`, emit N interleaved streams with distinct canned continuations. Randomize chunk delays so interleaving feels realistic.
- Client: `BranchPanel` grid (port from mockup), route SSE chunks by `choices[i].index`. "Write your own" box. Selecting a branch commits it and hides the rest as siblings per §4.6.
- Global kill switch aborts the fetch; server stops streaming on disconnect.
- **Proves:** N-branch UX, hide-not-delete semantics, cancellation under load.

### Phase 4 — Real TabbyAPI

- `server/bwbk/proxy.py`: replaces `mock.py` as the `/api/completions` handler behind a config flag (`BWBK_BACKEND=mock|tabby`). `httpx.AsyncClient` forwards to the configured TabbyAPI tunnel URL; client-side disconnect triggers upstream cancellation.
- Streamed Tabby proxy calls have a bounded read timeout (`BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS`, default 60s) so upstream GPU/Tabby hangs become visible UI errors instead of infinite spinners.
- Stand up TabbyAPI on a CUDA machine with `lucyknada/google_gemma-3-270m-exl3` at revision `6.0bpw`. TabbyAPI binds to remote `127.0.0.1:5000`; the laptop opens an SSH tunnel such as `ssh -N -L 5001:127.0.0.1:5000 root@host -p port -i ~/.ssh/id_ed25519`; the local app uses `BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions`.
- **Integration checks as deliverables:**
  - **Tunnel/backend health:** verify `GET /v1/model`, `GET /v1/models`, and a small `n=2` streamed completion through the local tunnel.
  - **Prefix reuse:** fan out from point A, navigate back, fan out again, confirm the second prefill is materially faster (server logs or `usage` field). Catches accidental whitespace/BOM mutation that silently breaks content-hash reuse (§4.2/§5).
  - **Crash recovery:** kill TabbyAPI mid-stream. Client shows a clear error; tree state is intact; restart TabbyAPI and continue (§9.2).
- **Status:** core real Tabby path is proven through the SSH tunnel: model/model-list checks work, `n > 1` SSE fan-out works, and the local wrapper can reach `/api/tabby/model`, `/api/tabby/models`, and `/api/tabby/token/encode`.
- **Proves:** real SSE, real sampler config, real branching, real prefix reuse.

### Phase 5 — Model loader UI + tokenizer

- Server endpoints: thin passthroughs to TabbyAPI's `/v1/model/load`, `/v1/model/unload`, `/v1/model`, `/v1/models`, `/v1/download`, `/v1/token/encode` (§6.3), exposed to the client as `/api/tabby/*`. Stream load-progress SSE through.
- Mock endpoints: keep parity for `/api/tabby/model`, `/api/tabby/models`, `/api/tabby/model/load`, `/api/tabby/model/unload`, `/api/tabby/download`, and `/api/tabby/token/encode` so local tests and UI work do not require an active GPU.
- Client: model status panel with current model, context budget, refresh, unload, local model load controls, and Hugging Face download controls.
- Tokenizer wiring: debounced POST to `/api/tabby/token/encode` on buffer change, show "X / max_seq_len tokens" in the status strip.
- **Status:** implemented and verified by `just check`; live wrapper checks against the active tunnel returned current model, model list, and token length successfully.
- **Remaining follow-up:** full manual browser pass against `just dev` with `BWBK_BACKEND=tabby` once UI polish begins. Current TabbyAPI cancels downloads when the HTTP request disconnects, so the download UI/documentation says to keep the request open.

### Phase 6 — Samplers + presets

- **Storage split (decided):** sampler presets are **user-global** and live in a separate SQLite file under `platformdirs`' app-support directory (`~/Library/Application Support/bwbk/userdata.sqlite` on macOS). They travel across every project. The *active* preset id is **per-project** — stored in that project's `project_meta` under `active_sampler_preset_id` — so confidential project folders don't leak their "which preset is active" choice into the global store. Tests override the userdata path via `BWBK_USERDATA_DIR`.
- Server: `bwbk.userdata` owns the global connection + seeds three starter presets (Creative / Balanced / Deterministic) using TabbyAPI's canonical `BaseSamplerRequest` field names. `bwbk.samplers` exposes `/api/samplers/presets` CRUD plus `GET/PUT /api/samplers/active`. Unused `user_preferences` table removed from the project schema.
- Client: sampler field catalog in `client/src/samplers/fields.ts` mirrors TabbyAPI's actual accepted sampler fields (temperature, min_p/top_p/top_k/top_a, typical_p, tfs, XTC, DRY, penalties, `min_temp`/`max_temp`/`temp_exponent` for dynamic temp, smoothing, temperature_last, `min_tokens`). Ooba-only fields that TabbyAPI ignores (seed, top_n_sigma, epsilon/eta_cutoff, smoothing_curve) are deliberately excluded. `mergePreset()` drops neutral-valued fields so TabbyAPI's own defaults stand.
- UI: right-side `SamplerDrawer` with preset dropdown + Save / Save as / Delete / Neutralize, plus a compact preset strip near Generate showing active preset + dirty marker. `max_tokens` is a separate required generate control near the Generate button, not part of sampler presets. Generate merges only the sampler draft into the `/api/completions` request and snapshots only sampler fields onto each generated node's `sampler_snapshot`.
- **Status:** implemented and verified by `just check` (ruff clean, 38 pytest, 24 vitest, build). Manual browser pass still useful before closing fully out.

### Deployment Track — RunPod fire-and-forget setup

This is not a product dependency. Branching Workbook must keep working with any GPU host running TabbyAPI behind an SSH tunnel. The RunPod track is a repeatable disposable-host setup path for convenience.

- Research current RunPod templates and Docker images that already provide TabbyAPI plus ExLlamaV3, SSH access, persistent volume mounting, and a startup hook.
- Prefer an existing maintained image/template if it can boot TabbyAPI with auth disabled, bind to `127.0.0.1:5000`, expose SSH, and leave model download/load to the Branching Workbook UI. Initial research found an existing Docker Hub image family `nschle/tabbyapi:*runpod` (https://hub.docker.com/r/nschle/tabbyapi), but it appears old enough that it needs validation before adoption.
- If no existing template is suitable, create a small custom template/image whose only responsibilities are installing TabbyAPI dependencies, starting TabbyAPI on localhost, and documenting the SSH tunnel command.
- Current repo helper: `deploy/runpod/` now contains a thin optional image based on `ghcr.io/theroyallab/tabbyapi:latest`. Its entrypoint starts `sshd`, writes a minimal config pointing `model_dir` at `/workspace/models`, sets `disable_auth: true`, and launches Tabby on `127.0.0.1:5000`. The companion README gives the exact template fields and tunnel command. This still needs real RunPod validation.
- RunPod templates support the knobs needed for this: Docker image, exposed ports such as `22/tcp`, environment variables, startup commands, container disk, and `/workspace` volume mounting (https://docs.runpod.io/pods/templates/manage-templates).
- Do not put RunPod API automation into Branching Workbook unless explicitly requested. A separate helper script or template README is acceptable if it remains optional infrastructure.
- Success criteria: start a fresh RunPod GPU instance, open one SSH tunnel from the laptop, run `just dev` with `BWBK_BACKEND=tabby`, download/load `lucyknada/google_gemma-3-270m-exl3` revision `6.0bpw` from the UI, and generate branches without manual shell edits on the pod.

### Phase 7 — Polish

- Hidden-nodes view toggle.
- **Project open/create UX.** Replace the typed-path flow with a native OS
  file dialog driven from the local FastAPI wrapper. The wrapper must not
  record, log, or persist any project paths, project titles, or other
  project-identifying data — confidential project folders may not leak. No
  recents list, no MRU cache, no telemetry of any kind. The dialog is the
  single source of truth and the path lives only in the running session.
- **Visual alignment + design polish.** Continue aligning the real app with
  `branching-workbook-mockup.jsx` (proportions, branch-card density, tree
  readability, model-modal ergonomics) and pursue further design improvements
  and stylistic balancing beyond a literal port. This work requires a real
  rendered-browser feedback loop; do not iterate blind.
- **Partial status:** first UI pass is committed. The app shell now uses the
  mockup's basic structure (top model strip, left tree rail, central
  manuscript buffer, bottom generate bar, right branch picker) with the
  smooth stone/paper palette rather than the earlier dark dashboard. Node
  names are persisted in project SQLite and editable inline above the buffer.
- **Current working-tree status:** the native macOS dialog path, foldable tree
  rows, resizable columns, sampler numeric inputs, Escape-to-close behavior,
  model loader labels, screenshot harness, and streamed Tabby timeout path are
  implemented and passing `just check`. Remaining Phase 7 work is real-browser
  verification and any visual/behavioral corrections found there.

## Out of scope for this plan

Everything in §2 "out of scope for v1." §11 v2 candidates likewise.

## Verification

Each phase has a concrete runnable deliverable under **Proves:**. End-to-end sanity check at any phase: `just dev`, open `localhost:5173`, perform the phase's canonical action (generate, commit, open a project, load a model, etc.), watch it work.

Unit tests: Vitest on `client/src/tree/reshape.ts` is the one place tests are non-negotiable in v1. The rest is thin enough that integration testing through the running app is sufficient.
