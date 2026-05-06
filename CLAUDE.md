# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo now has a working local implementation, not just the spec/mockup.

- `branching-workbook.md` remains the functional specification and source of truth for design decisions.
- `branching-workbook-mockup.jsx` remains a shape reference only. Do not import or extend it directly.
- `server/` contains the FastAPI wrapper, SQLite project persistence, mock completions endpoint, and TabbyAPI proxy.
- `client/` contains the Vite + React + TypeScript app, tree reshape logic, persistence adapters, and tests.
- `AGENTS.md` contains durable agent guidance for the disposable-GPU/SSH-tunnel backend workflow. Read it before changing TabbyAPI integration behavior.

## The load-bearing concepts in the spec

Read `branching-workbook.md` end-to-end before making design decisions, but these are the ideas that touch nearly everything and are easy to get wrong:

**Buffer-authoritative tree (§3.1).** The text buffer is the source of truth; the tree is reshaped to match edits via longest-common-prefix with the active path. Editing in the middle of an ancestor node causes that node to **split**, with the downstream portion preserved as a sibling branch — edits never destroy history. Any proposed tree-mutation logic must fall out of this algorithm, not invent its own.

**Fan-out via a single `/v1/completions` call with `n > 1` (§4.1, §6.3).** The client does **not** spawn N separate requests. TabbyAPI handles the concurrency and interleaves SSE chunks whose `choices[i].index` routes each chunk to its branch panel. Per-branch sampler overrides and per-branch mid-stream cancellation are explicitly unsupported — distinctness comes from sampling noise.

**Cross-job prefix reuse is inherited, not built (§4.2, §5).** ExLlamaV3's page table provides content-hashed cache reuse for free. Section 4.2 walks through why sequential-within-iteration prefill makes this O(1 prefill) for N branches instead of O(N). Do not design around "caching" as if it's the client's problem; the client's only job is to send the full prefix text and let the server hit its own cache.

**Three node sources (§3.2):** `generated`, `user_written`, `composed`. `composed` is semantically identical to `user_written` but flagged for UI affordances. Non-selected generated branches are **hidden, not deleted** (§4.6).

**Hoarder-friendly deletion model.** Nothing in the tree is ever destroyed by normal user action — deletes and edits reparent old content as hidden siblings.

## Architecture the spec commits to

- **Client/server split.** Client is local (laptop). Server is stock TabbyAPI on a GPU host, reached over an SSH tunnel (`ssh -L 5000:localhost:5000 gpu-host`). No custom server for v1 (§6.1, §10).
- **Planned client stack (§10).** React + TypeScript served by a small local HTTP wrapper (Python preferred — user's strongest language). Browser-only in v1; Electron/Tauri is post-v1.
- **Storage (§8).** Two stores, kept strictly separate:
  - **Per-project:** one SQLite file per project (`.bwbk`), schema in §8.2. The user chooses the path (may be a confidential folder). Tree is node-per-row with `parent_id`; main path is flagged via `is_main_path`. Sampler snapshots stored as JSON blobs. The per-project "active sampler preset id" lives in `project_meta`.
  - **User-global:** sampler presets and other cross-project preferences live in `~/Library/Application Support/bwbk/userdata.sqlite` (via `platformdirs` — see §8.2b). `server/bwbk/userdata.py` owns the connection and seeds starter presets. Tests point it elsewhere via `BWBK_USERDATA_DIR`. Never write project paths, project titles, or anything that identifies a project into this store — confidential projects must not leak.
- **Streaming.** Client uses the EventSource API against TabbyAPI's SSE; route by `choices[i].index`.
- **Tokenization.** Local JS tokenizer loaded from the model's `tokenizer.json` (preferred over round-tripping TabbyAPI's tokenize endpoint).
- **Endpoints the client uses (§6.3):** `POST /v1/completions`, `POST /v1/model/load`, `POST /v1/model/unload`, `GET /v1/model`, `GET /v1/models`, `POST /v1/download`. All are TabbyAPI-native; no custom endpoints.
- **Manuscript scroll container.** In prose mode the buffer scrolls inside `.bw-manuscript-scroll` (`overflow:auto`), **not** the window or CodeMirror's `.cm-scroller` (which is intentionally `overflow:visible` so the parent can scroll). Any code that needs to preserve reading position across a layout shift should target `.bw-manuscript-scroll` and prefer the `pinManuscriptScroll()` helper in `App.tsx` (distance-from-bottom anchor across two `requestAnimationFrame` ticks). Plain `setBuffer` while the editor is unfocused will yank the container to the top via contenteditable caret-into-view — that's the failure mode the helper exists to absorb.

## Tooling conventions

- **Python linting and formatting: `ruff`.** Run `just lint` (check) and `just fmt` (format). Config lives in `server/pyproject.toml` under `[tool.ruff]`. Ruleset is `E, F, W, I, UP, B, SIM` with line-length 100. Don't reach for black, flake8, or isort — ruff covers all of them.
- **Python env manager: `uv`.** `uv sync` in `server/` handles venv + install. Invoke tools with `uv run <cmd>`.
- **Command runner: `just`.** `justfile` at repo root. `just dev` runs server + client in parallel; `just install`, `just lint`, `just fmt`, `just check` are the other common ones.
- **Frontend: Vite + React + TS.** Dev server at `:5173`, proxies `/api/*` → `:8000`. No CORS — same-origin via the proxy.

## Scope discipline

§2 is explicit about what is **out of scope for v1** and worth re-reading before proposing features. High-frequency temptations that are deliberately excluded: per-branch sampler configs, per-branch mid-stream stop, speculative decoding, model hot-swap mid-session, cross-session KV cache persistence, search, chapter/outline views, markdown/rich-text in the buffer, import from files, author's notes / lorebooks, multi-user anything. §11 lists the handful of items deferred to v2 — propose additions there rather than silently widening v1.

## Working with the mockup

`branching-workbook-mockup.jsx` defines a single `App` component plus `TreeNode`, `BranchPanel`, `NodeNameHeader`, `ModelBar`, and `ModelModal` helpers. State lives entirely in the top-level `App` (`nodes` as an id-keyed object, `mainPath` as an id array, `currentId`, `buffer`, plus UI width/toggle state). `commitBranchToBuffer` is the canonical example of how a branch selection should turn into a new node + hidden siblings — consult it before writing equivalent logic in the real client, but port it rather than importing the file.
