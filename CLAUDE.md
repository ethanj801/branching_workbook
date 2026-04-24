# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo is **pre-implementation**. It contains only two artifacts:

- `branching-workbook.md` — the functional specification (the source of truth for all design decisions).
- `branching-workbook-mockup.jsx` — a single-file, self-contained React mockup that renders a visual approximation of the v1 UI. It is a design prop, not the eventual codebase: it uses `useState` with seed data, fakes streaming with `setTimeout`, and imports from `react` + `lucide-react` with Tailwind utility classes inline. There is no build system, `package.json`, test runner, or lockfile — the JSX is meant to be pasted into a React sandbox, not run from this directory.

No git commits exist yet (`git status` on `master` shows untracked files only). There are no build, test, or lint commands to run.

When asked to implement the real client, treat the `.md` as binding and the `.jsx` as a shape reference for layout/interactions — not code to extend in place.

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
- **Storage (§8).** One SQLite file per project (`.bwbk`), schema sketched in §8.2. Samplers stored as JSON blobs, not normalized columns. Tree is node-per-row with `parent_id`; the main path is flagged via `is_main_path`.
- **Streaming.** Client uses the EventSource API against TabbyAPI's SSE; route by `choices[i].index`.
- **Tokenization.** Local JS tokenizer loaded from the model's `tokenizer.json` (preferred over round-tripping TabbyAPI's tokenize endpoint).
- **Endpoints the client uses (§6.3):** `POST /v1/completions`, `POST /v1/model/load`, `POST /v1/model/unload`, `GET /v1/model`, `GET /v1/models`, `POST /v1/download`. All are TabbyAPI-native; no custom endpoints.

## Tooling conventions

- **Python linting and formatting: `ruff`.** Run `just lint` (check) and `just fmt` (format). Config lives in `server/pyproject.toml` under `[tool.ruff]`. Ruleset is `E, F, W, I, UP, B, SIM` with line-length 100. Don't reach for black, flake8, or isort — ruff covers all of them.
- **Python env manager: `uv`.** `uv sync` in `server/` handles venv + install. Invoke tools with `uv run <cmd>`.
- **Command runner: `just`.** `justfile` at repo root. `just dev` runs server + client in parallel; `just install`, `just lint`, `just fmt`, `just check` are the other common ones.
- **Frontend: Vite + React + TS.** Dev server at `:5173`, proxies `/api/*` → `:8000`. No CORS — same-origin via the proxy.

## Scope discipline

§2 is explicit about what is **out of scope for v1** and worth re-reading before proposing features. High-frequency temptations that are deliberately excluded: per-branch sampler configs, per-branch mid-stream stop, speculative decoding, model hot-swap mid-session, cross-session KV cache persistence, search, chapter/outline views, markdown/rich-text in the buffer, import from files, author's notes / lorebooks, multi-user anything. §11 lists the handful of items deferred to v2 — propose additions there rather than silently widening v1.

## Working with the mockup

`branching-workbook-mockup.jsx` defines a single `App` component plus `TreeNode`, `BranchPanel`, `NodeNameHeader`, `ModelBar`, and `ModelModal` helpers. State lives entirely in the top-level `App` (`nodes` as an id-keyed object, `mainPath` as an id array, `currentId`, `buffer`, plus UI width/toggle state). `commitBranchToBuffer` is the canonical example of how a branch selection should turn into a new node + hidden siblings — consult it before writing equivalent logic in the real client, but port it rather than importing the file.
