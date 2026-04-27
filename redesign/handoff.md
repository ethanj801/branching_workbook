# Branching Workbook redesign — handoff

This is a context dump for picking up the redesign work in a new
conversation. Paste it as your first message; it points at the spec
docs and explains what's been decided so far.

## Project, in one paragraph

Branching Workbook is a local writing tool for creative work with
local LLMs. The text buffer is the source of truth; the tree of nodes
reshapes around buffer edits via longest-common-prefix splits. Fan-out
generation uses a single `/v1/completions` call with `n > 1` against
TabbyAPI, with per-branch SSE chunks routed by `choices[i].index`.
Client is React + TypeScript on a Python (FastAPI) wrapper; backend
is stock TabbyAPI on a GPU host reached over an SSH tunnel. Two
SQLite stores: `.bwbk` per-project file and a user-global
`userdata.sqlite` for sampler presets. See `branching-workbook.md`,
`CLAUDE.md`, and `AGENTS.md` at the repo root for the full picture.

Repo: `/Users/EthanJ/Documents/github/branching_workbook`

## What's been done in the redesign folder

The folder `/Users/EthanJ/Documents/github/branching_workbook/redesign`
holds:

- **`picker-followup.md`** — post-redesign bug list (leading-zero
  on number inputs, N > 8 silent cap, grid balance for N ≥ 4 in the
  cards picker, branches:buffer ratio when the grid wraps). Bugs
  that were still open as of the last review pass against the live
  app at `localhost:5173`.
- **`autocomplete-mode.md`** + **`autocomplete-mode-wireframe.svg`**
  — spec for an autocomplete mode in prose files. Idle-fire ghost
  text continuation at end of line, Tab accepts, Ctrl+] / Ctrl+[
  cycles, infinite-feel pool with no count shown, configurable
  tokens-per-suggestion (default 2). It's a separate surface
  (tab next to "Compose"); tree and Branches panels are hidden in
  this mode.
- **`inline-display-mode.md`** + **`inline-display-wireframe.svg`**
  — spec for an alternate display option on the Compose-mode
  fan-out picker. Same fan-out as cards, but one candidate at a
  time inside a tinted preview block with vertical chevrons on the
  right edge; Use / Keep buttons; count shown (`Branch 1 of 3`).
  Toggle lives in the bottom bar.
- **`chat-mode.md`** + **`chat-mode-wireframe.svg`** +
  **`chat-mode-inline-wireframe.svg`** — spec for chat mode as a
  separate file type. Same data model as prose (tree of nodes) plus
  two extra node fields (`role`, `endOfTurn`) and chat-template
  wrapping on the wire. Cards display = three cards inside the
  assistant turn block; inline display = ghost-text continuation
  flowing out of the last accepted word in the same paragraph.
  Behavior of inline matches cards (Tab/Use commits, then waits for
  Generate); only the visual differs.

## Load-bearing design decisions

These are the calls most likely to be questioned mid-implementation,
with the reasoning preserved so they don't get unwound by accident.

- **Autocomplete is its own surface, not a knob on Compose.** It's
  about sustaining flow; cards mode is about committing decisions.
  Different writing postures, different chrome. Reached via a tab.
- **Autocomplete shows no count.** The pool refills in the
  background; a count would jitter. The user's mental model is
  "more options always available."
- **Compose-mode inline = tinted preview block.** Buffer text ends,
  candidate appears below in a small framed block. Distinct from
  ghost text because the candidate can be 256 tokens long and a
  wall of grey ghost text would be hard to read.
- **Chat-mode inline = ghost-text continuation, no frame.** The
  assistant turn block is *already* a container; a preview block
  inside it would be a frame within a frame. So the candidate
  flows directly out of the last accepted word in lighter color.
- **Chat-mode inline does NOT auto-fan-out after Tab.** It behaves
  like chat-mode cards: Tab commits, then user clicks Generate for
  the next chunk (or End turn). The visual happens to look like
  autocomplete, but the behavior is not autocomplete.
- **Chat is mostly template wrapping + visuals.** The data model
  is the same tree as prose with `role` and `endOfTurn` added per
  node. Turn boundaries are derived from `endOfTurn`; the renderer
  groups consecutive same-role nodes.
- **Generate fans out at the cursor's current position, role
  inferred from the active turn block.** Empty user-turn + Generate
  fans out for the user role.
- **Enter = newline; Cmd+Enter = end current turn.** Submission
  disambiguation in chat mode.
- **System prompt is just the first node** (role = system). Editing
  it, branching it, etc. all use the existing tree machinery.
- **Partial assistant chunks stay as separate nodes** in the tree.
  Renderer groups consecutive same-role nodes into one visual turn.
- **Ctrl+] / Ctrl+[ cycles** in both autocomplete and inline-display
  modes. Cmd-brackets are reserved by browsers; Option-brackets
  insert glyphs on macOS; Ctrl is the leftover safe modifier.

## What's deliberately out of scope

- Conversion between prose and chat file types.
- Multiple parallel conversations within one chat file.
- Roles beyond system / user / assistant.
- Image / audio attachments.
- Switching the loaded model mid-conversation in chat mode.
- Autocomplete inside chat turns.
- "Regenerate" as a discrete verb (achieved via branching).

## Open work

- The bugs in `picker-followup.md` need addressing in the existing
  cards picker.
- Implementation of the three new features per the specs.
- The shared `InlineCycler` component used by both autocomplete and
  inline-display should be factored out cleanly.
- The cards/inline display toggle should be wired into both Compose
  and chat modes.

## Conventions and house rules

- Python: `ruff` for lint + format, `uv` for env. Run via `just lint`,
  `just fmt`, `just dev`.
- Frontend: Vite + React + TS on `:5173`, proxied to the FastAPI
  wrapper on `:8000`. Same-origin via the proxy, no CORS.
- TabbyAPI is the inference boundary; client uses TabbyAPI-native
  endpoints (`/v1/completions`, `/v1/model/load`, etc.) directly. No
  custom server endpoints.
- Confidential project paths/titles must NEVER leak to the
  user-global SQLite store. See `AGENTS.md` for the full list.

## User preferences (from `.user_preferences`)

- Ask clarifying questions before diving in. The user often has
  context that's not in the prompt; check assumptions first.
- For literature / paper questions: if the source is paywalled or
  inaccessible, ASK the user to share it. Never present search
  results or abstracts as if you read the paper.
- No AI writing tropes. Specifically avoid: em-dash overuse,
  "It's not X — it's Y" parallelism, "Not X. Not Y. Just Z.",
  "the X? A Y." rhetorical questions, anaphora abuse, "delve",
  "tapestry", "landscape", "serves as", grandiose stakes
  inflation, "let's break this down", "here's the kicker", short
  punchy fragment-paragraphs, bold-first bullets, em-dash
  parenthetical asides, false vulnerability, "imagine a world
  where", historical-analogy stacking, signposted conclusions,
  "despite its challenges". Write like a normal person.
- Sentence case throughout. No Title Case, no ALL CAPS.

## Suggested next prompts to the new assistant

- "Read the redesign folder and confirm you understand the three
  features and the bug list."
- "Implement the leading-zero fix in the Branches and Max tokens
  number inputs (see picker-followup.md P1)."
- "Implement the autocomplete mode per `redesign/autocomplete-
  mode.md`. Start with the tab strip and full-width buffer; pool
  logic next."
- "Implement the cards/inline display toggle in Compose mode per
  `redesign/inline-display-mode.md`."
