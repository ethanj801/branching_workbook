# Inline display mode (Compose)

## Intent

The cards picker (the existing default) is good when you want to
compare candidates side by side: read three full continuations, weigh
them against each other, pick the best. It's a deliberate, comparing
posture.

Some users — and some moments within a single project — want a
different posture: one candidate at a time, evaluated quickly,
accepted or skipped. Less like a buffet, more like dealing cards. The
inline display gives the same fan-out as cards but renders one
candidate inside the buffer area, with cycle controls to swap, and the
same Use/Keep verbs the cards have.

The two displays are alternative skins on the same fan-out. Same
backend call, same N, same tokens, same tree integration. Only the
candidate-rendering differs.

## Design rationale

**Why two displays for the same fan-out?** Cards and inline reward
different reading patterns. Cards reward compare-and-contrast: see all
N at once, scan back and forth, pick. Inline rewards focused
evaluation: read one fully, decide, move on. Some users will prefer
one consistently; others will switch depending on the task. The cost
of supporting both is low — the underlying generation is identical —
so it's worth offering.

**Why the count *is* shown here, when autocomplete hides it.** The N
in Compose is bounded and explicit: the user typed "3" into Branches.
Showing `Branch 1 of 3` reflects something the user already knows and
gives a sense of how much remains to look at. In autocomplete the pool
is conceptually unbounded; a count there would lie about scarcity.

**Why a preview block, not ghost text.** A 256-token continuation
rendered as ghost text would be a wall of grey prose, hard to read and
hard to distinguish from committed text. A subtly tinted block with a
hairline border reads clearly as "this is a candidate, not committed
yet" without overwhelming the buffer.

**Why vertical chevrons on the right edge.** The block is wide;
horizontal chevrons at the bottom would compete with the action row
(Use / Keep) and feel cramped. Vertical chevrons centered on the right
edge are out of the way, discoverable, and don't move when block
height changes during streaming.

## Entry

Display mode toggle in the bottom bar of the Compose tab:

```
... · Branches 3 · Max tokens 256 · Display [ cards ] [ inline ] · ...
                                                ┌──────┐
                                                │selected│
                                                └──────┘
```

Two pills, one selected. The selection persists per project (in
`project_meta.display_mode`). Default for new projects: cards.

The toggle is interactive any time, including mid-generation. See
"Switching mid-generation" below.

## Visual surface

See `inline-display-wireframe.svg` for the layout.

The Compose tab is otherwise unchanged: tree on the left, buffer
center, no right rail (the rail's contents are now inside the buffer
area). The buffer flows above the preview block; cursor sits at the
generation point; the preview block appears below the cursor.

### Preview block

- Width: spans the buffer column with the same left/right padding as
  buffer prose.
- Background: subtle warm tint (`#FAFAF7` or 5% off the buffer
  surface).
- Border: 0.5 px hairline, `#D3D1C7` or `--color-border-tertiary`.
- Corner radius: 6 px.
- Internal padding: 16 px.
- Header line: small label, secondary color, reading
  `Branch 1 of 3 · 49 tok`. Updates as cycle changes the visible
  candidate, and as token count climbs during streaming.

### Cycle controls

A small floating control attached to the right edge of the preview
block, vertically centered:

- Width 40 px, height 36 px.
- Two chevrons stacked vertically — up = previous, down = next —
  separated by a 1 px divider.
- Click each chevron to cycle.
- Hairline border, light fill (matching the inline cycler in
  autocomplete).

If the buffer column is unusually narrow (< 300 px), fall back to
horizontal chevrons at the bottom-right corner of the block.

### Action row

Below the preview block:

- `Use` — filled primary button. Commits the visible candidate to
  the buffer.
- `Keep` — outline button. Saves as a hidden sibling without
  committing.
- Right-aligned hint text: `Tab accept · Ctrl+] / [ cycle · Esc clear`.

### Status text

While generation is in progress, status text below the action row
reads `1 of 3 generating`. When all candidates finish, it changes to
`3 candidates ready`. (Matches the cards-mode status string.)

## Pool model

Identical to cards. A single `/v1/completions` call with `n = N` where
N is the user's Branches setting. All N stream concurrently; the
inline display selects one as visible at a time but holds all N in
memory.

**Streaming order.** The first candidate to start streaming becomes
the initially visible one. As tokens arrive for the visible candidate,
they render into the preview block in real time. Tokens for
non-visible candidates accumulate silently in their buffers.

**Cycling during streaming.** Cycling to a candidate that's still
streaming shows whatever's been received so far. The block continues
to update as tokens arrive. Cycling away from a streaming candidate
doesn't interrupt it — the stream continues in the background.

**After all streams complete.** The block shows the chosen candidate's
full text. Cycle still works. Action buttons remain available. Pool
persists until the user clicks Use, Keep, Esc, or starts a new
Generate.

## Switching display mid-generation

Cards → inline:
- The currently focused (or first) card becomes the visible candidate.
- The other cards' content moves into the cycle queue, preserving
  order.
- Streams continue for all.

Inline → cards:
- Each candidate in the cycle queue rematerializes as a card in
  original order.
- Streams continue for all.

The display toggle is purely cosmetic; no backend state changes when
switching.

## Interaction

| Action | Key | Click target |
| --- | --- | --- |
| Commit visible to buffer | `Tab` | `Use` button |
| Save as hidden sibling | (none, mouse only) | `Keep` button |
| Cycle to next | `Ctrl+]` | down chevron |
| Cycle to previous | `Ctrl+[` | up chevron |
| Dismiss preview block | `Esc` | (`Clear` button if shown) |

Notes:

- `Tab` competes with focus traversal; `event.preventDefault()` while
  preview is visible.
- `Keep` has no default keybind. Saving an alternate is rare enough
  that requiring a click is fine. `Cmd+S` is reserved for project
  Save and shouldn't be repurposed.

## Settings

| Setting | Default | Persistence |
| --- | --- | --- |
| Display mode | cards | per-project (`project_meta.display_mode`) |
| Branches | 3 | per-project |
| Max tokens | 256 | per-project |

Display mode is the only inline-specific setting. Everything else is
shared with cards.

## Tree integration

Identical to cards picker:

- `Use` → commit visible candidate as new leaf, others discarded
  (not saved by default — same as cards behavior post the
  hoarder-mode change).
- `Keep` → save visible candidate as hidden sibling, don't commit.
- `composed` / `generated` node sources apply as in cards.

## Backend / API

Same `/v1/completions` request as cards. Display mode is purely a
client-side choice.

```json
POST /v1/completions
{
  "model": "<active>",
  "prompt": "<full buffer text>",
  "n": 3,                   // == user's Branches setting
  "max_tokens": 256,        // == user's Max tokens setting
  "stream": true,
  ...sampler fields from active preset
}
```

`Stop` aborts as today (single `AbortController` shared across the
fan-out).

## State machine

```
       ┌──────────┐
       │   idle   │  no preview block
       └────┬─────┘
            │ user clicks Generate
            ▼
       ┌──────────┐
       │streaming │  preview block visible, tokens arriving
       └────┬─────┘
            │ all streams complete
            ▼
       ┌──────────┐
       │  ready   │  preview block visible, no streaming
       └────┬─────┘
            │ Use / Keep / Esc / new Generate
            ▼
       (back to idle)
```

## Implementation hints

The cycle indicator should be a shared `InlineCycler` component used
by both this mode and autocomplete (`autocomplete-mode.md`). Different
parents, different sizes, but same focus / keybind / chevron rendering
logic.

Reasonable shape for the picker state:

```ts
type PickerState =
  | { phase: 'idle' }
  | {
      phase: 'streaming' | 'ready';
      candidates: Candidate[];
      visibleIdx: number;
      abort: AbortController;
    };

type Candidate = {
  text: string;
  tokens: number;
  source: 'generated';
  branchId: string;  // tree node id when committed
};
```

Both displays (cards / inline) read from the same `PickerState`. The
display toggle is just a render switch.

## Edge cases

- **N = 1.** No cycle. Chevrons hidden. Header reads `Branch 1` (no
  "of 1"). Use / Keep available.
- **Switching display mid-generation.** Active streams continue, see
  "Switching display mid-generation" above.
- **Streaming order varies.** First-to-start is visible by default.
  User can cycle to any candidate before it's done streaming;
  cycling to a not-yet-started candidate shows an empty block with a
  "thinking" placeholder.
- **Stop pressed during streaming.** All streams abort. Preview shows
  whatever was received. Action buttons remain available — the user
  can Use a partial candidate.
- **N candidates dedupe to fewer.** Currently dedupe is not applied
  in cards mode either; carry the same behavior to inline. (If
  dedupe is added later, apply to both.)
- **Very long candidate text.** Block grows vertically. If it
  exceeds available buffer area height, the block scrolls internally
  rather than the buffer.
- **User edits buffer prose during streaming.** The
  buffer-authoritative reshape may invalidate the streams (the
  prefix changed). Cards mode currently cancels in this case; match
  that behavior.

## Out of scope for v1

- An "auto-pick the highest-scoring candidate" mode (would require
  scoring; out of v1).
- Side-by-side preview at small N (e.g. show 2 candidates side by
  side at N=2, single at N≥3). Possible refinement; not v1.
- Persistent display preference *across* projects (currently
  per-project; user-global is plausible v2).
- Inline display in chat mode (chat has its own picker semantics;
  revisit when chat lands).
