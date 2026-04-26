# Autocomplete mode

## Intent

When you're drafting prose and want continuous, low-stakes assistance —
a word at a time, no decisions to make about which of three full
paragraphs to pick — the cards picker is the wrong tool. Cards are for
committing decisions; autocomplete is for sustaining flow. The two
modes serve different writing postures and should both exist.

The autocomplete mode borrows from IDE tab-completion. While the user
writes, the model proposes a small continuation at end of line; Tab
commits it; another suggestion immediately appears for the new end of
line. There is no Generate button, no fan-out picker, no comparison
step. The user types, accepts, or ignores.

The mental model: the writer is in control, the AI is a suggestion the
writer takes or doesn't.

## Design rationale (the load-bearing decisions)

These are the decisions an implementer is most likely to second-guess,
and the reasons each was made.

**No count on the cycle indicator.** The pool refills in the
background; a count would jitter as new options arrive. Even with a
fixed pool, the user's mental model is "more options always
available," and showing `1 of 7` suggests scarcity that isn't real.
Just the chevrons, no number.

**End of line, not at cursor.** The mode is about extending
*what's currently being written*, not about inserting at arbitrary
points. If the cursor is mid-paragraph somewhere else, no ghost text
appears — autocomplete is silent until the user's writing position
matches the suggestion position.

**Suggestions are short by default (1–2 tokens, ~one word).**
Anything longer turns autocomplete into a fan-out picker. The
distinction with Compose mode is purpose: autocomplete is a granular
keystroke-level assist, not a "write a paragraph for me" feature.

**No reject key.** Continued typing that diverges auto-dismisses; Esc
explicitly dismisses; nothing else is needed. Adding a "next batch"
key (Cmd+. and similar) was considered and rejected: the system
already keeps a fresh pool ready, so explicit re-roll is redundant.

**Tree panel hidden in this mode.** The user is in flow, not
navigating. Same for the Branches panel, the Generate button, and the
Branches input — irrelevant chrome that competes for attention. Buffer
gets the full width.

## Entry

Autocomplete is its own surface, reached via a tab strip at the top of
the workspace next to "Compose":

```
[ Compose ]  [ Autocomplete ]
                  ─────────────
```

Switching tabs preserves the buffer state. The same `.bwbk` file is
open in both tabs; only the editing surface differs. Tab state itself
is per-session — opening a project always starts in Compose by
default. (A "default to autocomplete" project preference is plausible
v2.)

## Visual surface

See `autocomplete-mode-wireframe.svg` for the layout.

The autocomplete tab differs from Compose in four ways:

- **Tree panel hidden.** State is preserved so flipping back to Compose
  restores it.
- **Branches panel hidden.** No fan-out cards in this mode.
- **Buffer full-width.** All horizontal space goes to writing.
- **Bottom bar simplified.** Only autocomplete-relevant controls:
  Preset, Samplers, Tokens per suggestion, Save. No Branches input, no
  Max tokens, no Generate.

### Inline ghost text

When the system has a suggestion ready and the user's cursor is at the
end of a line, a single suggestion appears as ghost text continuing
the line:

```
his first instinct was to|ignore
                          ▲
                          ghost text (lighter color)
```

Styling rules:

- Same font, same size as buffer body.
- Lighter fill color (medium gray, `#888780` or equivalent
  `--color-text-secondary`).
- No italic, no underline.
- No background fill behind it.
- Anchored to end of line, not cursor position.

### Cycle chevrons

A small floating control sits below the start of the ghost text:

- Width 48 px, height 20 px, fully rounded pill.
- Hairline border, light fill (`#FAFAF7` or
  `--color-background-primary`).
- Two chevrons separated by a thin divider.
- Click either chevron to cycle.

No count text, no labels. Just the two arrows.

## Pool model

The user perceives an infinite stream of alternatives. The system fakes
infinity via a rolling pool kept full in the background.

**Algorithm.**

1. **Trigger** — the user pauses past the idle debounce (default
   250 ms), or finishes a token boundary (space, punctuation, Enter).
2. **Initial fan-out** — single `/v1/completions` call with
   `n = pool_target` (default 10), `max_tokens = tokens_per_suggestion`
   (default 2), prompt = current buffer text up to end of line.
3. **Dedupe** — as suggestions stream in, deduplicate
   (case-insensitive trim, exact match). The first unique result
   becomes the visible ghost text; the rest go into the pool in order
   received.
4. **Pre-extension (background)** — for each unique pool member, fire
   an extension request with prompt = buffer + member, same
   `max_tokens`. Attach each extension to its parent so accepting that
   member immediately surfaces its extension as the new visible ghost
   text (no perceived gap).
5. **Cycling** — Ctrl+] advances visible to next pool member. Ctrl+[
   goes back. Wrapping at the ends is silent.
6. **Acceptance** — Tab commits the visible suggestion to the buffer
   as if typed. The pool flushes; trigger fires; new pool fills.
7. **Divergent typing** — if the user types a character that doesn't
   start any pool member, ghost text and chevrons hide immediately.
   Trigger fires after debounce.
8. **Convergent typing** — if the user types a character that matches
   the start of one or more pool members, ghost text remains, the
   matching prefix becomes part of typed text (committed), and the
   pool shrinks to only matching members.
9. **Empty pool** — no ghost text, no chevrons. No spinner, no
   placeholder. Quiet absence. User keeps typing; when next pool
   resolves, ghost text reappears.

## Keybindings

| Action | Key |
| --- | --- |
| Accept the visible suggestion | `Tab` |
| Dismiss without re-rolling | `Esc` |
| Cycle to next alternative | `Ctrl+]` (Mac & PC) |
| Cycle to previous alternative | `Ctrl+[` (Mac & PC) |

Notes for the implementer:

- `Ctrl` is the cross-platform modifier we settled on. On macOS,
  `Option+]` and `Option+[` insert curly-quote glyphs in textareas, so
  Option is unusable. `Cmd+brackets` are reserved by browsers for
  navigation. `Ctrl` is the leftover safe modifier on Mac, and the
  natural choice on Win/Linux.
- `Tab` competes with browser focus traversal; `event.preventDefault()`
  whenever ghost text is visible.
- `Esc` is similarly intercepted only while ghost text is visible.
- Continued typing handles rejection; no explicit reject key.

## Settings

**Bottom-bar visible:**

| Setting | Default | Purpose |
| --- | --- | --- |
| Preset | (active) | Sampler preset, shared with Compose |
| Samplers | drawer | Same drawer as Compose |
| Tokens per suggestion | 2 | Length of each ghost text. Range 1–8 reasonable; longer makes autocomplete behave like a small fan-out. |

**Hidden (config-level, not exposed v1):**

| Setting | Default | Purpose |
| --- | --- | --- |
| Pool target N | 10 | The `n=` value sent to TabbyAPI |
| Pre-extension enabled | true | Whether to fire extension batches |
| Idle debounce ms | 250 | How long after typing pause before firing |
| Trigger on word boundary | true | Fire immediately on space/punctuation |

## Tree integration

Each Tab acceptance creates a `composed` node child of the current
leaf. Buffer-authoritative reshape applies normally.

Unaccepted suggestions in a fired pool are *not* saved to the tree.
This differs from Compose mode, where Keep is an explicit hoarding
verb. In autocomplete the volume of suggestions would otherwise drown
the tree, so persistence is opt-out by default — only what's accepted
survives.

## Backend / API

Single call per pool, identical to existing `/v1/completions`:

```json
POST /v1/completions
{
  "model": "<active>",
  "prompt": "<full buffer text>",
  "n": 10,
  "max_tokens": 2,
  "stream": true,
  "temperature": 0.8,
  ...other sampler fields from active preset
}
```

Pre-extensions are separate `/v1/completions` calls per unique pool
member, with that member appended to the prompt and the same
`max_tokens`.

Cancellation: when the user types divergently, abort all in-flight
requests for the previous pool. One `AbortController` per call.

ExLlamaV3's content-hashed cache gives near-zero prefill cost when the
prefix is reused; client doesn't need to do anything to make this
happen.

## State machine

```
                  ┌──────────┐
                  │   idle   │  no ghost text
                  └────┬─────┘
                       │ user pauses or word-boundary
                       ▼
                  ┌──────────┐
                  │ thinking │  request in flight, no ghost text
                  └────┬─────┘
                       │ first response received
                       ▼
                  ┌──────────┐
                  │ showing  │  ghost text + chevrons visible
                  └────┬─────┘
                       │
            ┌──────────┼──────────────────┐
            │          │                  │
       Tab pressed     │           divergent type
            │          │                  │
            │   Esc / no input             │
            │          │                  │
            ▼          ▼                  ▼
       ┌────────┐  ┌────────┐         ┌────────┐
       │ commit │  │  idle  │         │  idle  │
       └────┬───┘  └────────┘         └────────┘
            │ trigger fires
            ▼
       (back to thinking)
```

## Implementation hints

For the cycle indicator, prefer a single React component
(`InlineCycler`) shared with the inline display picker
(`inline-display-mode.md`). The two surfaces have different sizes and
different parents, but the keybind handling, focus state, and chevron
rendering are the same code.

Pool state is naturally a small reducer:

```ts
type PoolState =
  | { phase: 'idle' }
  | { phase: 'thinking'; abort: AbortController }
  | { phase: 'showing'; pool: Suggestion[]; visibleIdx: number };

type Suggestion = {
  text: string;
  extension?: string;  // populated as background extension resolves
};
```

Debounce on user typing should reset the trigger timer, not stack
multiple. A leading-edge debounce on word boundaries (fire
immediately) plus a trailing-edge debounce on idle (fire after pause)
gives the right feel.

## Edge cases

- **Cursor not at end of line.** No ghost text. To get autocomplete
  back, click to end of line or keep typing forward.
- **Empty buffer.** Autocomplete still works; pool fires from empty
  prompt. Useful for kickstarting a draft.
- **User types faster than the model.** No ghost text. Typing wins.
- **Rapid Tab presses.** Each Tab commits the visible suggestion;
  next pool may not be ready in time, so the user briefly types
  without ghost text.
- **Switching to Compose tab.** Cancel all in-flight requests.
  Buffer state preserved.
- **Project switch.** Same as tab switch — full cancel, fresh state.
- **Network failure.** Show a small persistent badge "Autocomplete
  offline" near the bottom bar; suspend ghost text generation until
  the connection recovers. No retries from inside the autocomplete
  loop.
- **Model unloaded.** Same — no ghost text until a model is loaded.
  The badge can read "no model loaded."

## Out of scope for v1

- Autocomplete inside chat-mode turns (revisit when chat lands).
- Per-suggestion token visualization (e.g. dimming by probability).
- Multi-line ghost text. If a suggestion would wrap or contains a
  newline, truncate at the first line break.
- "Suggested next sentence" mode (longer ghost text where Tab accepts
  the whole sentence). Plausible v2.
- User-customizable keybinds.
- Per-pool analytics surfaced to the user.
