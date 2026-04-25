# Phase 7 — open issues

Working list captured 2026-04-25 mid-session. Each entry is short on
purpose; the spec / code are the source of truth, this file just keeps
the queue from getting lost across compactions.

## Functional bugs / behavior

### B1. Branch generation appears sequential, not parallel
**User report:** when Generate fires with N>1, branches stream one after
another instead of all at the same time.

**Likely cause:** still unknown. Per spec §4.1 / §6.3 we send a single
`/v1/completions` call with `n>1` and route by `choices[i].index`.
`server/bwbk/mock.py` is interleaved by test, and
`server/bwbk/proxy.py` is byte-passthrough. Re-test against live Tabby
now that the GPU hang was resolved.

**Where to look:**
- `server/bwbk/mock.py` — already covered by
  `test_completions_streams_interleaved_fanout_indexes`.
- `server/bwbk/proxy.py` — passthrough should be byte-for-byte; verify
  no buffering. If still seen, add temporary per-frame timestamps and
  `choices[*].index` logging.
- `client/src/api.ts` `streamJsonEvents` — confirm we don't accidentally
  group frames.

### B2. Escape should close the model picker modal
The model modal currently only closes via the `Close` button or
backdrop click. Hitting Escape should close it. Apply the same to the
sampler drawer for consistency.

**Status:** done.

### B3. `cache_mode` (Q4/Q6/Q8/FP16) dropdown is unlabeled
The model loader has an unlabeled select next to `max_seq_len` showing
`Q4 / Q6 / Q8 / FP16`. The user (correctly) couldn't tell what it
referred to. It is the K/V cache quantization mode. **Action:** label
the field `Cache (K/V)` or similar so it's self-explanatory.

**Status:** done.

### B4. Proxy streams can hang forever if TabbyAPI stalls
`server/bwbk/proxy.py` previously used `httpx.AsyncClient(timeout=None)`
for streamed upstream calls. If TabbyAPI accepted the request but stopped
sending bytes, the UI spinner could run forever.

**Status:** done. Streamed Tabby calls now use a 60s read timeout by
default (`BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS`). Mid-stream timeout
emits a structured SSE error frame; the client turns that into a visible
generation/model-load error.

## UI / UX

### U1. Sequential-generation visual confusion (depends on B1)
If B1 turns out to be a server bug, fix server. If branches really do
stream interleaved but the rendered effect *looks* sequential because
each branch only receives a chunk every few hundred ms, consider
rendering a small "•" pulse on cards currently receiving tokens so the
user sees activity.

### U2. Tree nodes should fold/collapse
Each tree row with children should have a disclosure caret. Folding
state is UI-only (does not persist to the project DB). Hidden nodes
respect the existing `show hidden` toggle independently.

**Status:** done.

### U3. Drop "3 on path" / "5 on path" text
The tree rail header currently shows e.g. `5 on path` under the `TREE`
kicker. User considers this not useful. Remove.

**Status:** done.

### U4. Resizable panels
The three columns (tree rail / editor / branch picker) should be
draggable to resize. Min widths from the existing `minmax()` grid
should be respected. State is per-session; do **not** persist drag
sizes (consistent with the no-recording rule).

**Status:** done.

### U5. Bottom action-bar font sizing
"Samplers" button text reads visibly larger than the surrounding
`Preset / Branches / Max tokens` field labels. Cause: `.bw-button`
inherits the body font size while `.bw-field` labels are smaller.
**Action:** harmonize. Either bump field labels up, or shrink
action-bar buttons. Lean on a single 12–13px scale across the bar.

**Status:** done.

### U6. Sampler drawer — add number input alongside slider
Each numeric sampler field currently shows only the slider + a
read-only value display. User wants a small number input (so values
can be typed precisely). Layout idea: `label  [slider]  [number]`.

**Status:** done.

## Done in this session (for context)

- Native macOS file dialog (osascript) for project open/create.
  No path/title persistence anywhere.
- Playwright screenshot harness at `client/scripts/screenshots.mjs`,
  recipe `just shots`. Captures welcome / project / model modal /
  sampler drawer / branch picker (streaming + ready).
- Welcome state restyle: vertically centered frontispiece, larger
  serif title, topbar drops project-only chrome when no project.
- Tree rail current/path treatment: 2px state-colored left edge, soft
  state fill on the current row.
- Node name editor: `NAME THIS SECTION` kicker affordance when
  unnamed, real serif heading when named.
- Sampler drawer empty state: `No preset active` instead of
  `(no preset selected)`.
- Branch card direction A: distinct manuscript fill, hover lifts
  border to `--state`, `Use` button promotes to primary on card
  hover. Compose card differentiated.
- Spec/plan: §7.7 status indicators removed from
  `branching-workbook.md`; Phase 7 keyboard-shortcut item removed
  from `implementation-plan.md`.

## Decisions locked in this session

- No project path / title / identifier may be persisted, logged, or
  cached anywhere. Native dialog is the only filesystem-identity
  surface. Recents lists / MRU are explicitly out.
- One restrained accent color introduced (`--state: #3f5566`) reserved
  for active / current / focus indications. Otherwise stay
  warm-monochrome.
- Branch-card direction A is the chosen direction (not the
  margin-annotation alternative).
- Mockup is a reference, not gospel. Aim for good design beyond a
  literal port.

## Out of scope (don't drift back into these)

- Status indicators, generic keyboard shortcut set, recents lists,
  per-branch sampler configs, status pressure indicators. These are
  excluded by the spec or by explicit user direction this session.
