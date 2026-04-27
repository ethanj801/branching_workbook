# Chat mode

## Intent

Some users want to use the same branching workbook to talk to a model
rather than write prose with one. Same tree, same fan-out, same
buffer-authoritative reshape — but rendered as a conversation, with
turns, role labels, and chat-template wrapping when the model is
called.

The pitch to the user is: a chat client where every assistant
response is a tree of alternatives instead of a single message, where
you can fan out partway through a response, and where editing any
past turn forks the conversation cleanly.

## Design rationale

**The data layer is unchanged.** Chat mode is mainly two things:
template wrapping on the wire, and chat-styled rendering on screen.
Beneath both, the document is the same tree of nodes the prose mode
already uses. Roles (system / user / assistant) are an attribute on
each node, alongside `source` (`generated` / `user_written` /
`composed`).

This decision keeps complexity small: the picker, fan-out,
buffer-authoritative reshape, hidden siblings, and tree view all
work without modification. What the user sees as "a turn" is just one
or more consecutive same-role nodes on the active path; what the user
sees as "the conversation" is the active path itself.

**Partial chunks don't condense.** When a user composes a long
assistant turn through several fan-outs (`Use`, fan out, `Use`, fan
out, …), each accepted chunk stays as its own node in the tree.
Renderer groups consecutive same-role nodes into one visual turn
block. Tree-side, the chain stays — which is friendlier to later
editing and to the buffer-authoritative reshape.

**Active position determines what role gets generated.** There's no
mode-switch for "now I want a user turn" vs "now I want an assistant
turn." The cursor is in a turn block; that block has a role; Generate
fans out for that role. Ending a turn moves the cursor into a new
turn block of the opposite role.

**System prompt is just a node.** Specifically, the first node in the
tree, with `role = system`. Editing it is editing a node. Branching it
(creating a sibling system node) creates a parallel conversation
lineage with a different system prompt; both lineages are visible in
the tree on the left.

## File type

Chat is a separate file type from prose, set at project creation.
A `.bwbk` file is one or the other. v1 doesn't allow conversion in
either direction.

The project metadata (`project_meta.kind`) holds the type. Loaders
key off this to render the right surface. Projects open into the
appropriate mode automatically.

## Visual surface

See `chat-mode-wireframe.svg`.

The main column is a vertical transcript, scrollable. Tree panel on
the left works the same way as in prose mode. No fan-out cards in a
right rail — fan-out happens inline in the assistant turn block being
composed.

### Transcript layout

Top to bottom:

- **System prompt strip.** Single-line collapsed by default, with a
  chevron and a truncated preview of the system text. Click expands
  into an editable block. Most users set it once; collapsing keeps
  it out of the way during conversation.
- **Turn blocks**, one per turn, alternating user / assistant.
- **In-progress turn block**, if any.
- **Next user-turn input**, when the previous assistant turn has
  ended.

### Turn block style

All turn blocks share a base style and differentiate by role label
and a small visual cue:

- Width: full transcript column with consistent padding.
- Border: 0.5 px hairline.
- Corner radius: 6 px.
- Internal padding: 16 px.
- Background:
  - System: `#F1EFE8` (warm muted).
  - User: transparent (default surface).
  - Assistant: `#FAFAF7` (very subtle warm tint).
- Header row: small uppercase or secondary-color label reading the
  role (`SYSTEM`, `YOU`, `ASSISTANT`). Assistant in-progress also
  shows token count: `ASSISTANT · in progress · 22 tok`.

### In-progress assistant turn with fan-out

The active assistant turn block contains:

1. Already-accepted chunks rendered as normal turn body text.
2. The fan-out display, sized to fit inside the turn block. Two
   variants depending on the Display toggle (see below).
3. An action row at the bottom: an `End turn` button on the left,
   keyboard-shortcut hint on the right.

Everything related to composing the turn lives inside one block,
matching the mental model that the candidates are *the next chunk of
this turn*.

### Cards display (inside the assistant block)

A divider line separates accepted text from the fan-out area, then a
small subheader reads `NEXT CHUNK · N candidates generating` (or
`ready` once streams complete). Below the subheader, N cards laid out
horizontally — the same layout as Compose-mode cards, scaled to the
turn block's width. Each card has its own `Use` and `Keep` buttons.

See `chat-mode-wireframe.svg` for this variant.

### Inline display (inside the assistant block)

No divider, no subheader, no separate frame. The candidate flows
directly out of the last accepted word as a ghost-text continuation
of the same paragraph: accepted text in normal color, candidate text
in lighter color (`#888780` or `--color-text-secondary`), all in one
continuous text run.

Below the ghost-text region, a single row of controls: a small
chevron pill (`‹ ›`), a `Keep` button, and a meta line reading
`Branch X of N · K tok · Tab accept · Ctrl+] / [ cycle · Esc clear`.

`Tab` commits the visible candidate (it becomes regular-color text
appended to the accepted chunk). `Use` is implicit in `Tab`; there's
no separate `Use` button in this variant since the candidate is
already shown in place. After commit, the picker disappears; the user
clicks `Generate` to fan out the next chunk, or `End turn` to close
the turn. Behavior matches the cards display in every respect except
the visual.

See `chat-mode-inline-wireframe.svg` for this variant.

### User-turn input

Looks like any user turn block, but with an editable text area inside
and a placeholder hint when empty. Submission gestures explained
under "User-turn submission" below.

## Data model

```ts
type Node = {
  id: string;
  parentId: string | null;
  role: 'system' | 'user' | 'assistant';
  source: 'generated' | 'user_written' | 'composed';
  text: string;
  endOfTurn: boolean;   // true if this node closes its turn
  ...
};
```

Two new fields on the node beyond what prose mode already has:
`role` and `endOfTurn`. Everything else (parent, children, source,
text, hidden siblings) is identical.

`endOfTurn = true` marks the last node of a turn. The renderer uses
this to know where to break visually (and to insert a fresh user-turn
input when the active path's tail is `endOfTurn = true` on an
assistant node). EOS detection sets this flag automatically; the
manual `End turn` button sets it.

Consecutive same-role nodes on the active path that are *not*
`endOfTurn` are part of the same logical turn, rendered as one block.

## Generation flow

The single rule: **Generate fans out at the cursor's current
position; the role of the resulting nodes matches the role of the
turn block the cursor is in.**

### User-turn submission

While composing a user turn, the gestures are:

| Gesture | Effect |
| --- | --- |
| `Enter` | Newline within the user turn |
| `Cmd+Enter` | End the user turn, create a fresh assistant turn block at end of transcript, auto-fire fan-out for the assistant role |
| `Generate` button | Fan out at the cursor position. If user-turn has text and cursor is at end, behaves identically to extending a prose buffer. If user-turn is empty, fans out for the user role (model proposes what the user might say). |

The disambiguation between "I'm typing a paragraph break" and "I'm
submitting" is the modifier on Enter. Plain Enter never submits;
Cmd+Enter always does.

### Empty user turn + Generate

When the user-turn block is empty (no text yet) and the user clicks
Generate, the model fans out user-role candidates. Same picker
(cards or inline). `Use` makes the chosen candidate the user turn's
text; `Keep` saves it as a hidden sibling.

After `Use` populates the user turn, the user can edit further or
press `Cmd+Enter` to submit. There's no auto-end.

### Assistant turn flow

When the user submits a user turn (`Cmd+Enter`), a fresh assistant
turn block is created at the end of the transcript and fan-out
auto-fires for the assistant role. From there:

- User picks a candidate with `Use` → that chunk appends to the
  assistant turn (becomes a child node, role = assistant,
  source = composed, endOfTurn = false unless the chunk's stream
  ended in EOS).
- After `Use`, the picker disappears. The user can:
  - Click `Generate` to fan out the next chunk.
  - Click `End turn` to close the turn manually.
  - Edit the just-accepted chunk if they want to tweak it before
    continuing (buffer-authoritative reshape applies).
- If the streamed chunk ended in EOS, `endOfTurn` is set on that
  node and the assistant turn closes automatically. A new user-turn
  input appears below.

### Multi-chunk turns

Repeating the loop "fan out → Use → fan out → Use" lets the user
compose a long assistant turn out of several short fan-outs. Each
chunk is its own node in the tree; the renderer groups them. The
buffer-authoritative reshape still works inside the chain — editing
chunk 2 forks the tree at chunk 2 and chunks 3+ become hidden
siblings.

### EOS detection

Each `/v1/completions` response is parsed for the active model's
end-of-turn token (defined in the chat template). When EOS is in the
stream output:

1. The token is stripped from the rendered chunk text.
2. The chunk's node has `endOfTurn = true`.
3. The picker closes after the user picks (or auto-closes if the
   user lets the streams finish without picking — same idle as
   inline picker today).
4. A fresh user-turn input appears below the assistant block.

If no EOS is received and the stream completes (`max_tokens` hit),
the chunk is an ordinary `endOfTurn = false` node. The user has to
either fan out again or click End turn.

### End turn (manual)

Inside an in-progress assistant block, an `End turn` button. Clicking
it sets `endOfTurn = true` on the most recent assistant node on the
active path and creates a fresh user-turn input block.

`Cmd+Enter` while the cursor is anywhere in the assistant block has
the same effect.

## Branching behavior

Identical to prose mode:

- Editing a turn forks the tree at that node via
  buffer-authoritative reshape; downstream content becomes hidden
  siblings.
- `Keep` on a fan-out candidate saves it as a hidden sibling without
  committing.
- The tree panel shows all branches; switching active path works the
  same way.

System prompt branching: editing the system node creates a sibling.
Both system nodes have downstream subtrees; switching active path
between them swaps the entire conversation lineage.

User-turn branching: editing a previous user turn forks at that
turn; assistant responses below become hidden siblings of the new
edit's children.

## Settings

| Setting | Default | Persistence |
| --- | --- | --- |
| File type | chat (set at creation) | per-project (`project_meta.kind`) |
| Display mode | cards | per-project, shared with prose Compose |
| Branches | 3 | per-project |
| Max tokens | 128 | per-project (smaller default than prose, since chat chunks are typically shorter) |
| Active sampler preset | (whatever's loaded) | per-project |

System prompt is part of the tree (the system node's text), not a
separate setting.

## Backend / API

### Template wrapping

Before each `/v1/completions` call, the client builds the prompt by
walking the active path and wrapping each node in the loaded model's
chat template. For example, with the ChatML template:

```
<|im_start|>system
You are a helpful writing assistant.
<|im_end|>
<|im_start|>user
Tell me a story about a lighthouse keeper.
<|im_end|>
<|im_start|>assistant
The lighthouse keeper had not had a visitor in seventeen
```

For mid-turn fan-out (the example above), the prompt ends *without*
a closing `<|im_end|>` so the model continues the assistant turn
rather than starting a fresh role.

Template details (the actual marker tokens) come from the model's
`tokenizer_config.json` `chat_template` field, available from the
TabbyAPI model load response.

### EOS parsing

The streaming chunk handler watches for the model's EOS token (also
from the chat template / tokenizer config). On EOS:

- Stop accepting tokens for that branch.
- Flag the node as `endOfTurn`.
- Strip EOS from the rendered text.

### Request shape

Same `/v1/completions` body as prose:

```json
{
  "model": "<active>",
  "prompt": "<templated transcript>",
  "n": 3,
  "max_tokens": 128,
  "stream": true,
  "stop": ["<|im_end|>"],
  ...sampler fields
}
```

`stop` is set to the chat template's end-of-turn marker so the model
halts at the natural turn boundary; the client still parses any EOS
that arrives in case the model emits it before hitting the stop
sequence.

## State machine

The chat surface has more states than the prose surface, but each is
a small refinement of "what's the active node and what role gets
generated."

```
                ┌──────────────────────┐
                │  user-turn composing │  cursor in user block
                └──────────┬───────────┘
                           │ Cmd+Enter
                           │
                ┌──────────▼───────────┐
                │ user-turn submitted  │ active path adds a user node, ends the turn
                └──────────┬───────────┘
                           │ auto-fan-out for assistant
                           ▼
                ┌──────────────────────┐
                │ assistant streaming  │ picker visible inside the assistant block
                └──────────┬───────────┘
                           │ Use a card  /  Stop  /  Esc
                           ▼
                ┌──────────────────────┐
                │  assistant chunk     │ chunk committed; user can extend or end
                │  committed           │
                └──────────┬───────────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
        Generate       End turn         EOS in stream
              │            │                │
              │            ▼                │
              │  ┌──────────────────────┐   │
              │  │ assistant turn ended │◄──┘
              │  └──────────┬───────────┘
              │             │
              ▼             ▼
      (back to streaming)  (user-turn composing)
```

## Edge cases

- **EOS detection.** The model's EOS token (from the tokenizer
  config) closes the turn automatically. If a chunk's stream
  finishes without EOS, the chunk stays `endOfTurn = false` and the
  user has to either fan out again or click End turn.
- **Empty user-turn submission.** Pressing Generate with an empty
  user turn fans out for the user role — model proposes what the
  user might say. Same picker (cards / inline). `Use` populates the
  user turn; user can edit and submit normally.
- **Editing a previous turn.** Standard buffer-authoritative
  reshape: the edit creates a sibling at that node, downstream
  becomes hidden siblings. Tree panel reflects the new branch.
- **Stop during streaming.** Same as inline picker — abort, partial
  chunk available to Use or Keep. If the user Uses a partial chunk,
  it's `endOfTurn = false`.
- **Multiple back-to-back fan-outs in the same turn.** Main loop,
  not really an edge case. Each Use appends a node; each fan-out
  fires from the new tail.
- **Max tokens without EOS.** The chunk completes with
  `endOfTurn = false`. User extends or ends manually.
- **Branching the system prompt.** Editing the system node creates
  a sibling system node. Each lineage has its own conversation
  subtree. Switching active path between them changes which system
  prompt is in effect.
- **Cursor in a non-tail node.** If the user clicks into a previous
  turn's block and starts typing, the buffer-authoritative reshape
  forks at that point — same as editing prose mid-document. The
  current active tail moves to the new edit's children.

## Out of scope for v1

- Conversion between chat and prose file types. Chat → prose is
  future-plausible (flatten turns, strip role markers); prose → chat
  has no clean recovery.
- Multiple parallel conversations within one project. There's one
  tree per file; "different conversations" are different paths
  through the tree.
- Roles beyond system / user / assistant (e.g. "tool" for function
  calling).
- Image / audio / file attachments in turns.
- Switching the loaded model mid-conversation. The current model's
  template is used for sends; previously-generated turns aren't
  re-templated retroactively.
- Autocomplete inside chat turns. Plausible v2; out of v1.
- "Regenerate" as a discrete action. The same effect is achieved by
  branching: edit the turn (or fan out again) and the new attempt
  is just a sibling.
