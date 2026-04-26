# Branch picker — post-redesign review

The redesign landed cleanly. Side-by-side cards in a CSS grid with the
buffer below at full width, divider in the right place, per-card token
counter and a streaming-dot indicator next to the branch label,
`Use` / `Keep` separated, `Stop` replacing `Generate` during a stream,
and `Untitled section` rendered as h2 instead of a caption.

Two bugs to fix and two layout follow-ups.

## P1 — leading zero on number inputs (bug)

**Repro.** On either Branches or Max tokens: triple-click the value,
press Backspace, type any digit. Field shows `05`, `01`, etc.

**Root cause.** The input is a controlled component whose state is a
number. Backspacing the field clean coerces state to `0`, which React
re-renders into the DOM as the literal "0". The next keystroke appends
to that 0. (Confirmed with JS: after Backspace, `valueAsNumber === 0`
and `.value === "0"` with the cursor at end.)

**Fix.** Hold these inputs as strings during editing; parse to a number
only when a number is actually needed. Don't coerce mid-typing — empty
is a valid intermediate state.

```ts
const [branchesText, setBranchesText] = useState('3');
const branches = clamp(parseInt(branchesText, 10) || DEFAULT, 1, maxBranches);

<input
  type="number"
  value={branchesText}
  onChange={e => setBranchesText(e.target.value)}
  onBlur={() => setBranchesText(String(branches))}  // normalize on blur
/>
```

Apply the same shape to Max tokens. The `onBlur` normalization is what
guarantees the field can't be left in `""` or `"0"` after the user
moves on.

## P2 — N > 8 silently caps (bug)

**Repro.** Type `10` into Branches, click Generate. Eight cards render;
the input still shows `10`.

**Root cause.** The input has `max="8"`, but `max` on a number input
only constrains the spinner buttons — typed values pass through. The
form lets `10` go out, the request ships, and somewhere downstream
(probably TabbyAPI's `max_batch_size` or a model-specific limit) it
gets clamped to 8. The UI never tells the user that.

**Fix — two parts that go together.**

1. **Enforce on blur, not just on submit.** If the user types a value
   above the cap and tabs out, snap the input to the cap and show an
   inline hint next to the field: `max 8 with this model` (12 px,
   secondary color, beside the number input). The input must never
   display a value the system won't honor.

2. **Make the cap dynamic, not hardcoded `8`.** The real bound is the
   loaded model's `max_batch_size` (or whichever TabbyAPI field you
   prefer). When the user loads a different model, the cap may change.
   Read it from the model load response and store it on the model
   state; pass it into the Branches input as both the `max` attribute
   and the clamp ceiling. The hint string above can interpolate it
   (`max ${maxBranches} with this model`) so the message stays correct
   when the cap changes.

Until the dynamic-max plumbing is done, at least surface the current
cap as placeholder/tooltip on the field so the user isn't surprised.

## P3 — grid balance for N ≥ 4 (polish)

**Symptom.** With N=8 the grid came out 5+3 — five cards on the top
row, three on the bottom — which reads as visually unbalanced. With
the current `repeat(auto-fit, minmax(220px, 1fr))` and the present
viewport, 5 columns is what fits. So whenever N isn't a multiple of
the auto-computed column count, the last row underfills.

**Why this is worth fixing.** The picker's job is to support side-by-
side comparison. A ragged last row makes the eye linger on the gap
instead of the candidates, and the lone trailing cards feel like
afterthoughts.

**Fix.** Use a per-N preset for column counts instead of pure
`auto-fit`:

| N   | Columns × rows |
| --- | --- |
| 1   | 1 × 1 |
| 2   | 2 × 1 |
| 3   | 3 × 1 |
| 4   | 2 × 2 |
| 5   | 3 × 2 (last row underfilled — acceptable at small N) |
| 6   | 3 × 2 |
| 7   | 4 × 2 (last row underfilled) |
| 8   | 4 × 2 |
| 9   | 3 × 3 |

Implement as `grid-template-columns: repeat(${cols}, 1fr)` driven by a
small lookup against N. Above N=9, fall back to `auto-fit` and trust
the viewport.

If a row is underfilled (N=5, N=7), center the trailing card(s) by
giving the last row `justify-content: center` rather than left-
aligning the gap.

## P4 — branches/buffer ratio when wrapped (polish)

**Symptom.** When the grid wraps to two rows, the branches:buffer
ratio doesn't shift — branches sit at roughly 38% of vertical, buffer
at 62%. Each card ends up about 110 px tall (header 24, content ~50,
buttons 26), so the visible reading window inside a card is two lines
of prose before scrolling. With 8 cards that's not enough to skim.

**Why.** The redesign brief called for the branches:buffer ratio to
shift to ~65:35 when the grid wraps to two or more rows. The reasoning:
more cards = more time the user spends reading vs composing, and the
buffer hasn't yet become the focus (no Use clicked yet). That shift
isn't currently happening.

**Fix.** Tie the divider's default position to the row count of the
grid, not just the project. Roughly:

- Single-row grid (N ≤ 3 in most viewports): branches:buffer 50:50
- Two-row grid: 65:35
- Three-row grid (rare, N ≥ 9): 75:25

Persist user-driven divider drags per project as today, but compute
the *initial* ratio from row count when no persisted value exists for
the current N.

While at it, the per-card content area should be at least 4 lines of
prose tall (~100 px) for skim-readability. With internal scroll
already in place, that's a function of the card's allotted height —
which is downstream of the row-count-based ratio above.
