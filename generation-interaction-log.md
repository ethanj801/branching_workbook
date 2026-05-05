# Generation Interaction Log

## Background

Branching Workbook is a local creative-writing tool. The user writes in an
editor, asks a model for continuations, inserts generated text into the editor,
edits that text, uses autocomplete, stops streams early, and moves between
branch contexts.

The current writing tree is designed for drafting. It preserves alternate paths,
supports branch navigation, and lets the visible workspace stay focused on the
current writing task. The tree is also mutable in the normal course of use:
nodes can be reshaped, hidden, promoted, renamed, and merged into different
visible paths as the buffer-authoritative editing model does its work.

The interaction log has a different job. It should preserve the observable facts
needed for later SFT, data analysis, and workflow analysis:

- the exact editor state at meaningful app boundaries
- the exact prompt sent to the model
- the exact request body forwarded to the model backend
- the exact text streamed back by each candidate
- the exact text shown to the user for autocomplete
- the exact editor operation performed when generated text enters the buffer
- the later editor states after truncation, rewriting, deletion, continuation,
  or branch switching

The log belongs inside the project `.bwbk` SQLite file because it contains
confidential project text and model output. Disk growth is acceptable. The point
is to avoid cluttering the writing tree and UI with every rejected or stopped
generation while still preserving the data.

The log records mechanical facts. A Compose button may be labeled "Use" in the
UI, but the log records `generated_text_inserted`: generated text was inserted
into the editor. That event does not claim the text was accepted as final prose.

## Current `.bwbk` Contents

Project files are SQLite databases. They currently contain:

- `project_meta`
- `nodes`

`project_meta` stores per-project metadata and settings. Current keys include:

- `version`
- `created_at`
- `title`
- `display_mode`
- `branch_count`
- `max_tokens`
- `tokens_per_suggestion`
- `active_sampler_preset_id`

`nodes` stores the writing tree:

```text
id
parent_id
text
name
source
hidden
is_main_path
starred
created_at
sampler_snapshot
seed
model_identifier
prior_context_hash
```

User-global data lives outside `.bwbk`, in `userdata.sqlite`. That store holds
cross-project data such as sampler presets and settings. Interaction history
stays project-local.

## Design Summary

Add a project-local interaction log alongside the existing node tree. The
historical facts are append-only; a few summary fields may be updated for
convenient queries and derived exports.

The primary units are:

- `text_snapshots`: full editor text at exact workflow boundaries
- `text_contexts`: explicit loaded-editor contexts and their open/close bounds
- `generation_runs`: one model request and its transport lifecycle
- `generation_candidates`: one model output stream under a run
- `candidate_text_updates`: append-only streamed text updates
- `interaction_events`: UI and lifecycle events
- `log_sessions`: app sessions used for cleanup and crash handling

Every row that represents the creation of something receives a project-global
`log_sequence`. This creates one canonical creation order across sessions,
contexts, snapshots, runs, candidate rows, candidate text updates, and events.

Some tables also contain mutable summary fields for convenience, such as the
current run status or the current accumulated candidate text. Those summary
fields are not canonical history. Canonical history comes from creation rows,
append-only text updates, and append-only interaction events.

The log uses immutable snapshot ids and run/candidate ids. The log avoids
durable references to `nodes.id`; the writing tree remains a separate mutable
structure.

## Existing Tree Relationship

The node tree still does the writing work:

- save/commit reshapes nodes
- branch selection loads path text into the editor
- Keep can continue to create hidden generated nodes
- main path, hidden state, and starred state stay node concerns

The interaction log records what the user and model saw. When an operation also
changes the node tree, the log records the operation after it succeeds. The log
does not use the node id as the identity of that operation.

## Global Ordering

All log append operations allocate from one project-global sequence.

One implementation is:

```sql
CREATE TABLE IF NOT EXISTS log_clock (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    next_sequence INTEGER NOT NULL
);
```

Every append transaction:

1. Reads `next_sequence`.
2. Uses that value as `log_sequence`.
3. Increments `next_sequence`.
4. Commits the row and clock update together.

The sequence is the authoritative ordering mechanism. Timestamps support human
inspection and duration analysis.

Use epoch milliseconds for log timestamps:

```text
created_at_ms
updated_at_ms
started_at_ms
ended_at_ms
```

## Sessions And Abandoned Work

Add session rows:

```sql
CREATE TABLE IF NOT EXISTS log_sessions (
    id                 TEXT PRIMARY KEY,
    log_sequence       INTEGER NOT NULL UNIQUE,
    started_at_ms      INTEGER NOT NULL,
    ended_at_ms        INTEGER,
    last_heartbeat_ms  INTEGER NOT NULL,
    status             TEXT NOT NULL CHECK (status IN (
        'active',
        'closed',
        'crashed'
    )),
    app_instance_id    TEXT,
    process_hint       TEXT
);
```

Every snapshot, run, candidate row, candidate update, and event stores
`session_id`.

On project open:

1. Acquire the project's normal single-writer open state.
2. If another active session has a fresh heartbeat, refuse a second writer or
   open read-only.
3. Create a new `log_sessions` row for this writer.
4. If project ownership cannot be acquired after creating the row, immediately
   close that session row before returning the failure.
5. If prior active sessions have stale heartbeats, mark those sessions
   `crashed`.
6. Mark `streaming` runs from crashed sessions `abandoned`.
7. Mark streaming candidates from those runs `abandoned`.

This prevents cleanup from misclassifying active work when two app processes
touch the same project.

## Offset Contract

All text offsets in the log use JavaScript string offsets:

```text
utf16_code_units
```

This matches browser textarea selection APIs. Every table or JSON object with
offset fields includes:

```text
offset_units = 'utf16_code_units'
```

Downstream Python analysis must convert deliberately when it wants Unicode code
points, grapheme clusters, or UTF-8 byte offsets.

Selection fields use the same offset units:

```text
selection_start
selection_end
selection_direction
```

`selection_direction` is one of:

```text
forward
backward
none
unknown
```

## Text Snapshots

A text snapshot is a boundary record. The app appends a snapshot at every
defined workflow boundary, even when the editor text is unchanged from the
previous snapshot.

This is deliberate. The snapshot row says:

```text
at this boundary, the editor contained this exact text and selection
```

The snapshot reason remains truthful because boundary rows are never deduped.
If future storage optimization is needed, deduplicate text in a separate content
table while keeping boundary snapshot rows append-only.

Schema:

```sql
CREATE TABLE IF NOT EXISTS text_snapshots (
    id                  TEXT PRIMARY KEY,
    log_sequence        INTEGER NOT NULL UNIQUE,
    session_id          TEXT NOT NULL REFERENCES log_sessions(id),
    created_at_ms       INTEGER NOT NULL,
    context_id          TEXT NOT NULL,
    reason              TEXT NOT NULL CHECK (reason IN (
        'project_opened',
        'compose_started',
        'autocomplete_started',
        'before_candidate_insert',
        'candidate_inserted',
        'before_autocomplete_insert',
        'autocomplete_inserted',
        'before_context_switch',
        'context_loaded',
        'node_commit',
        'project_closing'
    )),
    parent_snapshot_id  TEXT REFERENCES text_snapshots(id),
    text                TEXT NOT NULL,
    text_hash           TEXT NOT NULL,
    selection_start     INTEGER NOT NULL,
    selection_end       INTEGER NOT NULL,
    selection_direction TEXT NOT NULL CHECK (selection_direction IN (
        'forward',
        'backward',
        'none',
        'unknown'
    )),
    offset_units        TEXT NOT NULL DEFAULT 'utf16_code_units'
        CHECK (offset_units = 'utf16_code_units')
);

CREATE INDEX IF NOT EXISTS idx_text_snapshots_context_sequence
    ON text_snapshots(context_id, log_sequence);

CREATE INDEX IF NOT EXISTS idx_text_snapshots_parent
    ON text_snapshots(parent_snapshot_id);
```

`text_hash` is SHA-256 over the UTF-8 bytes of `text`.

`parent_snapshot_id` links snapshots inside the same editor context. A
`context_loaded` or `project_opened` snapshot starts a new context and has
`parent_snapshot_id = NULL`.

## Text Contexts

A text context records one loaded editor context. It makes context ranges
explicit instead of requiring export code to infer them from later snapshots.

Schema:

```sql
CREATE TABLE IF NOT EXISTS text_contexts (
    id                    TEXT PRIMARY KEY,
    log_sequence          INTEGER NOT NULL UNIQUE,
    session_id            TEXT NOT NULL REFERENCES log_sessions(id),
    opened_at_ms          INTEGER NOT NULL,
    open_reason           TEXT NOT NULL CHECK (open_reason IN (
        'project_opened',
        'context_loaded'
    )),
    previous_context_id   TEXT REFERENCES text_contexts(id),
    opening_snapshot_id   TEXT NOT NULL,
    closed_at_ms          INTEGER,
    close_reason          TEXT CHECK (close_reason IN (
        'context_switch',
        'project_close',
        'project_crash'
    )),
    closing_snapshot_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_text_contexts_session_sequence
    ON text_contexts(session_id, log_sequence);
```

`opening_snapshot_id` is the snapshot created when the context opens.
`closing_snapshot_id` is the final snapshot in the context when the app closes
or switches away from it.

The snapshot ids are not declared as SQL foreign keys here to avoid a circular
insert dependency between opening a context and creating its opening snapshot.
The application enforces the relationship in one transaction.

## Editor Contexts

An editor context is a log-owned id for the text currently loaded into the
editor.

Create a new `context_id` when:

- a project opens and initial text is loaded
- a different branch/path is loaded into the editor

Continue the same `context_id` when:

- the user edits the current buffer
- a Compose candidate is inserted
- autocomplete text is inserted
- the current buffer is committed to the node system
- a generation starts from the current buffer

This lets downstream analysis distinguish continuous editing from context
loading using recorded context open/close facts rather than text similarity.

## Snapshot Operations

### `openTextContext(reason, text, selection)`

Allowed reasons:

- `project_opened`
- `context_loaded`

Behavior:

1. Generate a new `context_id`.
2. Append a `text_contexts` row for the new context.
3. Append a `text_snapshots` row for the loaded text.
4. Set `parent_snapshot_id = NULL`.
5. Set `text_contexts.opening_snapshot_id` to the opening snapshot id in the
   same transaction.
6. Set client logging state:

```ts
activeContextId = newContextId;
activeSnapshotId = insertedSnapshotId;
```

This operation always inserts a row.

### `recordEditorSnapshot(reason, text, selection)`

Allowed reasons:

- `compose_started`
- `autocomplete_started`
- `before_candidate_insert`
- `candidate_inserted`
- `before_autocomplete_insert`
- `autocomplete_inserted`
- `before_context_switch`
- `node_commit`
- `project_closing`

Behavior:

1. Append a `text_snapshots` row.
2. Set `context_id = activeContextId`.
3. Set `parent_snapshot_id = activeSnapshotId`.
4. Set client logging state:

```ts
activeSnapshotId = insertedSnapshotId;
```

This operation always inserts a row. Equal text creates a new boundary snapshot
with the same `text_hash`.

## Complete Snapshot Write Points

The app writes snapshots at exactly these boundaries:

| Boundary | Operation |
| --- | --- |
| Project opened and editor text loaded | `openTextContext('project_opened', buffer, selection)` |
| Compose generation starts | `recordEditorSnapshot('compose_started', buffer, selection)` |
| Autocomplete generation starts | `recordEditorSnapshot('autocomplete_started', buffer, selection)` |
| Before Compose candidate insertion | `recordEditorSnapshot('before_candidate_insert', beforeBuffer, selection)` |
| Compose candidate inserted | `recordEditorSnapshot('candidate_inserted', afterBuffer, selection)` |
| Before autocomplete suggestion insertion | `recordEditorSnapshot('before_autocomplete_insert', beforeBuffer, selection)` |
| Autocomplete suggestion inserted | `recordEditorSnapshot('autocomplete_inserted', afterBuffer, selection)` |
| Before selecting another node/path | `recordEditorSnapshot('before_context_switch', buffer, selection)` |
| After selected node/path text is loaded | `openTextContext('context_loaded', loadedBuffer, selection)` |
| Explicit save / node commit outside generation or context switch | `recordEditorSnapshot('node_commit', buffer, selection)` |
| Project closing | `recordEditorSnapshot('project_closing', buffer, selection)` |

Internal commits that prepare for another boundary use that boundary's specific
reason. For example, Compose generation currently commits before streaming; the
snapshot reason is `compose_started`.

## Frontend Code-Path Matrix

The implementation should wire the boundaries above to these concrete app paths.
If a step fails before the named successful mutation, the log rows after that
step are not written.

| Code path | Logging contract |
| --- | --- |
| Project create/open/current-project load | After the project file is opened and the initial buffer is loaded, call `openTextContext('project_opened', loadedBuffer, selectionAtEnd)`. |
| Explicit save / Cmd-S / Save button | After `commitBuffer` successfully persists the reshape, call `recordEditorSnapshot('node_commit', buffer, selection)`. |
| Compose Generate | Dispose currently displayed compose candidates first. Persist the current buffer through the node system. After that succeeds, call `recordEditorSnapshot('compose_started', committedBuffer, selection)`, then create the run. Do not also write a `node_commit` snapshot for the same boundary. |
| Autocomplete request start | Cancel or dismiss the prior autocomplete run/suggestion as needed. Call `recordEditorSnapshot('autocomplete_started', fullBuffer, selection)`, then create the autocomplete run using the separately recorded prompt text. |
| Compose candidate insertion | Call `recordEditorSnapshot('before_candidate_insert', beforeBuffer, selection)`, perform the insertion, call `recordEditorSnapshot('candidate_inserted', afterBuffer, afterSelection)`, then append a generated-text insertion event. |
| Autocomplete insertion | Call `recordEditorSnapshot('before_autocomplete_insert', beforeBuffer, selection)`, insert the visible suggestion, call `recordEditorSnapshot('autocomplete_inserted', afterBuffer, afterSelection)`, then append a generated-text insertion event. |
| Clear branch picker / close branch strip / manual candidate drop | Append one per-candidate disposal event for every displayed candidate that is leaving the UI and has not already received an insertion or keep event. |
| Escape while autocomplete visible | Append a dismissal event for the visible suggestion, then cancel the active autocomplete stream if it is still running. |
| Buffer edit while autocomplete visible | Append dismissal/disposal events for visible autocomplete suggestions made stale by the edit; cancel the active autocomplete stream with `status_detail = 'buffer_changed'`; the next autocomplete request writes its own `autocomplete_started` snapshot. |
| Switch to Compose mode | If leaving autocomplete, dismiss visible autocomplete suggestions and cancel active autocomplete streams. If the buffer is committed as part of the switch, record `node_commit` after commit succeeds. |
| Switch to Autocomplete mode | No text snapshot solely for the mode change. The first autocomplete request writes `autocomplete_started`. |
| Switch to Map mode | If `dirtyBuffer` is true, commit the buffer and record `node_commit` after commit succeeds. This is not a context switch. |
| Select a node/path or set main thread | Record `before_context_switch`, append `context_switch_started`, commit the current buffer, close the current `text_contexts` row, load the target path text, then call `openTextContext('context_loaded', loadedBuffer, selectionAtEnd)`. |
| Map delete that changes the loaded path/buffer | Commit current buffer first. After the structural edit succeeds, close the current context and open a new `context_loaded` context for the resulting loaded buffer. |
| Map merge that changes the loaded path/buffer | Commit current buffer first. After the structural edit succeeds, close the current context and open a new `context_loaded` context for the resulting loaded buffer. |
| Map delete/merge that leaves the loaded buffer unchanged | No text snapshot is written for the structural change. The log remains focused on editor/model interaction facts. |
| Rename, hide, unhide, star, unstar | No text snapshot is written because the editor buffer is unchanged. |
| Explicit project close | Best effort: record `project_closing`, append `project_closing`, cancel active streams, close the current text context, mark the session closed, then close the project DB connection. |
| Browser/process crash | No new rows are written after the crash. On next project open, stale active sessions and streaming runs are marked crashed/abandoned. |

## Generation Runs

A generation run represents one request forwarded to the model backend.

Run status is transport lifecycle only. UI disposition lives in
`interaction_events`.

Schema:

```sql
CREATE TABLE IF NOT EXISTS generation_runs (
    id                     TEXT PRIMARY KEY,
    log_sequence           INTEGER NOT NULL UNIQUE,
    session_id             TEXT NOT NULL REFERENCES log_sessions(id),
    created_at_ms          INTEGER NOT NULL,
    updated_at_ms          INTEGER NOT NULL,
    kind                   TEXT NOT NULL CHECK (kind IN (
        'compose',
        'autocomplete'
    )),
    editor_snapshot_id     TEXT NOT NULL REFERENCES text_snapshots(id),
    prompt_text            TEXT NOT NULL,
    prompt_hash            TEXT NOT NULL,
    request_json           TEXT NOT NULL,
    forwarded_request_json TEXT NOT NULL,
    sampler_snapshot       TEXT,
    model_identifier       TEXT,
    status                 TEXT NOT NULL CHECK (status IN (
        'streaming',
        'completed',
        'stopped_by_user',
        'cancelled_by_system',
        'errored',
        'abandoned'
    )),
    status_detail          TEXT,
    started_at_ms          INTEGER NOT NULL,
    ended_at_ms            INTEGER,
    error_message          TEXT
);

CREATE INDEX IF NOT EXISTS idx_generation_runs_editor_snapshot
    ON generation_runs(editor_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_generation_runs_kind_sequence
    ON generation_runs(kind, log_sequence);
```

`editor_snapshot_id` points to the full editor state at request start.

`prompt_text` is the exact model prompt. For Compose it equals the editor
snapshot text. For autocomplete it can differ, because autocomplete may trim a
partial suffix before sending the prompt.

`request_json` is the request as assembled by the app before proxy-level
normalization.

`forwarded_request_json` is the exact serialized JSON body sent from the backend
proxy to TabbyAPI, stored as UTF-8 text. This is the source of truth for model
request analysis. The logged-completion endpoint should serialize the upstream
body once, store that string, and send that same string upstream.

Allowed transport terminal statuses:

- `completed`: upstream stream ended cleanly
- `stopped_by_user`: user requested stop
- `cancelled_by_system`: app cancelled the stream because a recorded app code
  path made the active stream obsolete
- `errored`: request failed
- `abandoned`: prior session crashed or disappeared while stream was active

Examples of `status_detail`:

- `autocomplete_inserted`
- `new_autocomplete_request`
- `buffer_changed`
- `context_switch`
- `project_close`
- `http_error`
- `project_open_cleanup`

## Generation Candidates

A candidate represents one model output stream under a run.

Schema:

```sql
CREATE TABLE IF NOT EXISTS generation_candidates (
    id                  TEXT PRIMARY KEY,
    log_sequence        INTEGER NOT NULL UNIQUE,
    session_id          TEXT NOT NULL REFERENCES log_sessions(id),
    run_id              TEXT NOT NULL REFERENCES generation_runs(id),
    candidate_index     INTEGER NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    updated_at_ms       INTEGER NOT NULL,
    final_text          TEXT NOT NULL DEFAULT '',
    final_text_hash     TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (
        'streaming',
        'completed',
        'stopped_by_user',
        'cancelled_by_system',
        'errored',
        'abandoned'
    )),
    model_finish_reason TEXT,
    token_count         INTEGER,
    UNIQUE (run_id, candidate_index)
);

CREATE INDEX IF NOT EXISTS idx_generation_candidates_run
    ON generation_candidates(run_id, candidate_index);
```

`final_text` is a convenience field maintained from the append-only updates.
For a stopped stream it contains the partial text received before stop.

Candidate status is transport status for that candidate. A candidate can be
transport-completed and later dismissed in the UI; dismissal is an interaction
event.

## Candidate Text Updates

Candidate text updates preserve streaming history and make crash recovery more
faithful.

Schema:

```sql
CREATE TABLE IF NOT EXISTS candidate_text_updates (
    id                    TEXT PRIMARY KEY,
    log_sequence          INTEGER NOT NULL UNIQUE,
    session_id            TEXT NOT NULL REFERENCES log_sessions(id),
    run_id                TEXT NOT NULL REFERENCES generation_runs(id),
    candidate_id          TEXT NOT NULL REFERENCES generation_candidates(id),
    received_at_ms        INTEGER NOT NULL,
    chunk_index           INTEGER NOT NULL,
    appended_text         TEXT NOT NULL,
    accumulated_text      TEXT NOT NULL,
    accumulated_text_hash TEXT NOT NULL,
    model_finish_reason   TEXT,
    UNIQUE (candidate_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_candidate_text_updates_candidate
    ON candidate_text_updates(candidate_id, chunk_index);
```

For each SSE choice:

1. Append a `candidate_text_updates` row. If the choice has a finish reason but
   no text, use `appended_text = ''` so the finish observation is ordered.
2. Update `generation_candidates.final_text`.
3. Update `generation_candidates.final_text_hash`.
4. Update `generation_candidates.updated_at_ms`.
5. Store `model_finish_reason` when present.

The logical log is append-only. The candidate row is a current summary.

## Interaction Events

Interaction events record UI and workflow facts.

Schema:

```sql
CREATE TABLE IF NOT EXISTS interaction_events (
    id                  TEXT PRIMARY KEY,
    log_sequence        INTEGER NOT NULL UNIQUE,
    session_id          TEXT NOT NULL REFERENCES log_sessions(id),
    created_at_ms       INTEGER NOT NULL,
    actor               TEXT NOT NULL CHECK (actor IN (
        'user',
        'system'
    )),
    event_type          TEXT NOT NULL CHECK (event_type IN (
        'stop_stream',
        'generated_text_inserted',
        'keep_candidate',
        'autocomplete_suggestion_evaluated',
        'autocomplete_visible_changed',
        'dismiss_autocomplete',
        'dispose_candidate',
        'context_switch_started',
        'context_loaded',
        'context_closed',
        'project_closing',
        'run_status_changed',
        'candidate_status_changed',
        'session_status_changed'
    )),
    context_id          TEXT REFERENCES text_contexts(id),
    run_id              TEXT REFERENCES generation_runs(id),
    candidate_id        TEXT REFERENCES generation_candidates(id),
    before_snapshot_id  TEXT REFERENCES text_snapshots(id),
    after_snapshot_id   TEXT REFERENCES text_snapshots(id),
    data_json           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_interaction_events_run
    ON interaction_events(run_id, log_sequence);

CREATE INDEX IF NOT EXISTS idx_interaction_events_candidate
    ON interaction_events(candidate_id, log_sequence);

CREATE INDEX IF NOT EXISTS idx_interaction_events_context
    ON interaction_events(context_id, log_sequence);
```

Events are append-only.

Transport status events use `actor = 'system'`.

`run_status_changed.data_json`:

```json
{
  "from_status": "streaming",
  "to_status": "stopped_by_user",
  "status_detail": null
}
```

`candidate_status_changed.data_json`:

```json
{
  "from_status": "streaming",
  "to_status": "stopped_by_user",
  "model_finish_reason": null
}
```

`session_status_changed.data_json`:

```json
{
  "from_status": "active",
  "to_status": "closed",
  "reason": "project_close"
}
```

## Compose Generation Flow

Starting Compose:

1. Validate that a model is loaded.
2. Persist the current buffer through the existing `commitBuffer` path.
3. Record `text_snapshots.reason = 'compose_started'` with the committed full
   editor text and current selection.
4. Build the completion request.
5. Send the request through the backend logged-completion endpoint.
6. Backend records `generation_runs` with:
   - `kind = 'compose'`
   - `editor_snapshot_id = snapshot from step 3`
   - `prompt_text = committed editor text`
   - `forwarded_request_json = exact upstream body`
   - `status = 'streaming'`
7. Backend creates `n` candidate rows and returns the `run_id` plus every
   `candidate_id` to the client before any candidate can be displayed.
8. The client stores candidate ids with the displayed candidates. Choice indexes
   remain backend routing metadata only.
9. Backend streams upstream chunks to the client and appends
   `candidate_text_updates`.

Normal completion:

1. Flush all candidate summaries.
2. Mark completed candidates `completed`.
3. Append `candidate_status_changed` events for candidates whose terminal
   status changed.
4. Mark the run `completed`.
5. Append `run_status_changed`.
6. Set `ended_at_ms`.

User stop:

1. Append `interaction_events.event_type = 'stop_stream'`.
2. Abort the upstream request.
3. Flush accumulated text.
4. Mark streaming candidates `stopped_by_user`.
5. Append `candidate_status_changed` events for candidates whose terminal
   status changed.
6. Mark the run `stopped_by_user`.
7. Append `run_status_changed`.
8. Set `ended_at_ms`.

System cancellation:

1. Append an interaction event that explains the workflow change when relevant,
   such as `dispose_candidate` or `context_switch_started`.
2. Abort the upstream request.
3. Flush accumulated text.
4. Mark streaming candidates `cancelled_by_system`.
5. Append `candidate_status_changed` events for candidates whose terminal
   status changed.
6. Mark the run `cancelled_by_system`.
7. Set `status_detail`.
8. Append `run_status_changed`.
9. Set `ended_at_ms`.

## Autocomplete Generation Flow

Starting autocomplete:

1. Capture the exact full editor buffer and selection.
2. Compute the exact model prompt. In the current app this is `trimmedPrompt`
   from `trimAutocompletePromptSuffix(buffer)`.
3. Capture autocomplete prompt-construction metadata:
   - `full_buffer_text`
   - `trimmed_prompt`
   - `partial_suffix`
   - `selection_start`
   - `selection_end`
   - `offset_units`
4. Record `text_snapshots.reason = 'autocomplete_started'` with the full editor
   buffer, not merely the trimmed prompt.
5. Send the request through the backend logged-completion endpoint.
6. Backend records `generation_runs` with:
   - `kind = 'autocomplete'`
   - `editor_snapshot_id = snapshot from step 4`
   - `prompt_text = trimmed_prompt`
   - `forwarded_request_json = exact upstream body`
   - `status = 'streaming'`
   - `status_detail = NULL`
7. Backend creates candidate rows and returns the `run_id` plus every
   `candidate_id` to the client before any suggestion can be displayed.
8. The client maps backend `choice.index` values to durable `candidate_id`
   values.
9. Backend appends text updates as chunks arrive.

When raw streamed text is evaluated for display:

1. Normalize the raw accumulated candidate text using the UI's autocomplete
   rules.
2. Append `interaction_events.event_type = 'autocomplete_suggestion_evaluated'`.
3. Use `candidate_id` on the event. `candidate_index` may appear inside
   `data_json` only as backend routing metadata.

`autocomplete_suggestion_evaluated.data_json`:

```json
{
  "candidate_index": 3,
  "slot_index": 1,
  "partial_suffix": "sof",
  "raw_accumulated_text": "softly",
  "state": "available",
  "visible_text": "tly",
  "dedupe_key": "tly",
  "normalization": {
    "trimmed_leading_newlines": true,
    "single_line_only": true,
    "removed_partial_suffix": true
  },
  "offset_units": "utf16_code_units"
}
```

Allowed evaluation states:

- `provisional`: more streamed text is needed before the UI can decide
- `available`: the suggestion entered the visible/poolable suggestion set
- `rejected`: the suggestion will not be shown for this request

For `state = 'provisional'` or `state = 'rejected'`, `visible_text` is `null`.

When the visible ghost text changes, append:

```text
interaction_events.event_type = 'autocomplete_visible_changed'
```

`data_json`:

```json
{
  "candidate_id": "cand_...",
  "slot_index": 1,
  "visible_text": "tly",
  "reason": "first_visible"
}
```

Allowed visible-change reasons:

- `first_visible`
- `cycle_next`
- `cycle_previous`
- `pool_update`
- `typed_prefix_converged`

Rejected or provisional evaluations use the same event:

```json
{
  "candidate_index": 4,
  "partial_suffix": "sof",
  "raw_accumulated_text": "\n\n",
  "state": "rejected",
  "visible_text": null,
  "reason": "empty_after_normalization"
}
```

Allowed evaluation reasons:

- `empty_after_normalization`
- `duplicate_visible_text`
- `does_not_match_partial_suffix`
- `still_waiting_for_enough_text`

`still_waiting_for_enough_text` is always `state = 'provisional'`, not a final
rejection.

Inserting autocomplete:

1. Record `before_autocomplete_insert` snapshot.
2. Insert the visible suggestion text into the editor.
3. Record `autocomplete_inserted` snapshot.
4. Append `interaction_events.event_type = 'generated_text_inserted'` with
   `source_kind = 'autocomplete'`.
5. If the stream is still active, cancel it and mark the run
   `cancelled_by_system` with `status_detail = 'autocomplete_inserted'`.

`generated_text_inserted.data_json` for autocomplete:

```json
{
  "source_kind": "autocomplete",
  "slot_index": 1,
  "partial_suffix": "sof",
  "visible_text": "tly",
  "inserted_text": "tly",
  "insert_start": 1204,
  "insert_end": 1207,
  "replace_start": 1204,
  "replace_end": 1204,
  "replacement_basis": "cursor_end",
  "offset_units": "utf16_code_units"
}
```

Dismissing autocomplete:

Append `interaction_events.event_type = 'dismiss_autocomplete'`.

Allowed dismissal reasons:

- `escape_key`
- `divergent_typing`
- `mode_switch`
- `context_switch`
- `new_autocomplete_request`

The run's transport status changes only if an active stream is actually
cancelled. A completed run can later receive dismissal events.

## Candidate Insertion

Compose candidate insertion records a mechanical editor operation.

Flow:

1. Record `before_candidate_insert` snapshot with current editor text and
   selection.
2. Compute replacement offsets from the current selection or previously inserted
   candidate range.
3. Insert the candidate text into the editor.
4. Record `candidate_inserted` snapshot.
5. Append `interaction_events.event_type = 'generated_text_inserted'` with
   `source_kind = 'compose'`.

Generated-text insertion events require:

- `run_id`
- `candidate_id`
- `before_snapshot_id`
- `after_snapshot_id`

`generated_text_inserted.data_json` for Compose:

```json
{
  "source_kind": "compose",
  "replace_start": 1204,
  "replace_end": 1230,
  "insert_start": 1204,
  "insert_end": 1288,
  "inserted_text": " The old woman stepped inside...",
  "visible_text": " The old woman stepped inside...",
  "replacement_basis": "selection",
  "replaced_insert_event_id": null,
  "compose_display_mode": "inline",
  "offset_units": "utf16_code_units"
}
```

Invariant:

```text
after_snapshot.text ==
  before_snapshot.text.slice(0, replace_start)
  + inserted_text
  + before_snapshot.text.slice(replace_end)
```

using UTF-16 code unit offsets.

If clicking another candidate replaces the prior inserted range, that click gets
its own before/after snapshots and its own `generated_text_inserted` event. If
the replacement is based on a previous insertion, set
`replacement_basis = 'prior_insert_range'` and set `replaced_insert_event_id` to
that earlier insertion event. If the user has edited inside the prior inserted
range, the replacement offsets still record the exact operation the app
performed.

## Keep Candidate

Keep preserves the existing hidden-generated-node behavior while recording the
interaction.

Flow:

1. Create the hidden generated node using existing behavior.
2. If node creation succeeds, append
   `interaction_events.event_type = 'keep_candidate'` with `run_id` and
   `candidate_id`.

`keep_candidate.data_json`:

```json
{
  "kept_candidate_text_hash": "sha256:...",
  "created_hidden_node_text_hash": "sha256:...",
  "created_hidden_node_parent_path_hash": "sha256:..."
}
```

The event records that Keep succeeded. The log keeps its identity in the event,
run, and candidate rows. The data may include volatile debug handles, but
canonical export must not require a mutable node id to interpret the keep event.

## Candidate Disposal And Declines

UI disposal is separate from transport lifecycle.

When candidates leave the active UI because the user starts another run,
switches context, closes the project, changes mode, drops a candidate, or closes
the picker, append one event per candidate:

```text
interaction_events.event_type = 'dispose_candidate'
```

`data_json`:

```json
{
  "reason": "new_compose_run",
  "disposition": "ignored"
}
```

Allowed reasons:

- `new_compose_run`
- `context_switch`
- `project_close`
- `mode_switch`
- `picker_closed`
- `manual_drop`

Allowed dispositions:

- `ignored`: candidate left the UI without generated-text insertion or Keep
- `ui_removed`: candidate left the UI after it already had an insertion or Keep
  event

Candidate-level decline analysis uses events:

- inserted candidates have `generated_text_inserted`
- kept candidates have `keep_candidate`
- available candidates with no insertion/keep before disposal were
  available and left the active UI

If one Compose candidate is inserted and the rest are ignored, the inserted
candidate has `generated_text_inserted`; the others receive
`dispose_candidate` events with `disposition = 'ignored'`.

## Node Switching

Node switching is represented by snapshots and events.

When selecting another node/path:

1. Record `before_context_switch` snapshot for the current editor text.
2. Append `interaction_events.event_type = 'context_switch_started'`.
3. Commit the current buffer to the node system using existing behavior.
4. Close the current `text_contexts` row with
   `close_reason = 'context_switch'` and `closing_snapshot_id` set to the
   `before_context_switch` snapshot.
5. Append `interaction_events.event_type = 'context_closed'`.
6. Load selected path text into the editor.
7. Open a new text context with `context_loaded`.
8. Append `interaction_events.event_type = 'context_loaded'`.

Example:

```text
S1 context=A reason=project_opened
text="The door opened."

S2 context=A reason=compose_started parent=S1
text="The door opened softly."

S3 context=A reason=before_context_switch parent=S2
text="The door opened softly. The old woman stepped in."

S4 context=B reason=context_loaded parent=NULL
text="The train arrived late."
```

The log knows `S4` came from a context load because the app recorded a context
load operation.

## Editing After Insertion

Example:

```text
S1:
The door opened.

G1 editor_snapshot_id=S1

C1:
 The old woman stepped inside and closed it behind her.
```

The user clicks the UI button labeled "Use". The log records:

```text
event_type=generated_text_inserted
candidate_id=C1
before_snapshot_id=S1
after_snapshot_id=S2

S2:
The door opened. The old woman stepped inside and closed it behind her.
```

The user edits the result:

```text
The door opened softly. The old woman stepped in.
```

At the next defined boundary, the log records:

```text
S3 parent=S2
reason=compose_started
text="The door opened softly. The old woman stepped in."
```

The app records:

- candidate text
- insertion operation
- immediate editor state
- later editor state

Later analysis classifies the relationship between C1, S2, and S3.

## Project Close And Crash Behavior

Project close:

1. Record `project_closing` snapshot.
2. Append `interaction_events.event_type = 'project_closing'`.
3. Close the current `text_contexts` row with `close_reason = 'project_close'`.
4. Append `interaction_events.event_type = 'context_closed'`.
5. Cancel active streams with run status `cancelled_by_system` and
   `status_detail = 'project_close'`.
6. Mark session `closed` and append `session_status_changed`.

This is a best-effort contract for explicit project close inside the running
app. Browser unload/process termination cannot be treated as a reliable flush
boundary.

Browser/process crash:

- snapshots and events already committed remain valid
- candidate text updates already committed remain valid
- active runs from the crashed session become `abandoned` on next project open
- active candidates from abandoned runs become `abandoned`
- cleanup appends `session_status_changed`, `run_status_changed`, and
  `candidate_status_changed` events for those transitions

The log records committed app facts at the boundaries listed above. It does not
record exact keystroke-level edits between boundaries. If the user inserts,
edits, truncates, and the process crashes before the next logged boundary, those
post-boundary edits are absent from the log by design.

## Export

There are two exports.

### Ordered Project Log

Primary export: immutable logged facts ordered by `log_sequence`.

The first row is export metadata:

```json
{
  "type": "export_metadata",
  "schema_version": 1,
  "app_version": "...",
  "exported_at_ms": 1710000000000,
  "export_as_of_log_sequence": 12345
}
```

Every following row has:

```json
{
  "log_sequence": 42,
  "type": "text_snapshot",
  "payload": {}
}
```

Allowed `type` values:

- `log_session_opened`
- `text_context_opened`
- `text_snapshot`
- `generation_run_started`
- `generation_candidate_created`
- `candidate_text_update`
- `interaction_event`

This export is the canonical reconstruction stream. It does not rely on current
mutable node state, and it does not export mutable summary values as if they
were true at creation time.

For `log_session_opened`, export only immutable open fields:

- `id`
- `started_at_ms`
- `app_instance_id`
- `process_hint`

Session closure or crash appears later as `session_status_changed`.

For `generation_run_started`, export only immutable start fields:

- `id`
- `session_id`
- `created_at_ms`
- `kind`
- `editor_snapshot_id`
- `prompt_text`
- `prompt_hash`
- `request_json`
- `forwarded_request_json`
- `sampler_snapshot`
- `model_identifier`
- `started_at_ms`

Do not include mutable summary fields in the canonical row:

- current `status`
- `status_detail`
- `ended_at_ms`
- `error_message`

Those facts appear later as `interaction_event` rows such as
`run_status_changed`.

For `text_context_opened`, export only immutable open fields:

- `id`
- `session_id`
- `opened_at_ms`
- `open_reason`
- `previous_context_id`
- `opening_snapshot_id`

Context closure appears later as an `interaction_event` row with
`event_type = 'context_closed'`; mutable `closed_at_ms`, `close_reason`, and
`closing_snapshot_id` fields from `text_contexts` are summary fields.

For `generation_candidate_created`, export only immutable creation fields:

- `id`
- `session_id`
- `run_id`
- `candidate_index`
- `created_at_ms`

Do not include mutable summary fields in the canonical row:

- `final_text`
- `final_text_hash`
- current `status`
- `model_finish_reason`
- `token_count`

Those facts appear through `candidate_text_update` and
`candidate_status_changed` rows.

### Generation-Centered Export

Derived export: one JSONL row per `generation_runs` row.

Each row includes:

- run summary as of export time
- exact forwarded request
- editor snapshot at run start
- prompt text
- candidate summaries as of export time
- candidate text updates
- interaction events for the run/candidates
- context snapshots from run start through context close

The context snapshot range is explicit:

```json
{
  "context_snapshot_range": {
    "context_id": "ctx_...",
    "start_log_sequence": 41,
    "end_log_sequence": 88
  }
}
```

`end_log_sequence` comes from the explicit `text_contexts` row:

- the `log_sequence` of `text_contexts.closing_snapshot_id` for closed contexts
- latest snapshot in that context at export time, if the context is still active

The derived export must also include `export_as_of_log_sequence`, because run
and candidate summaries are computed as of that point.

## Implementation Notes

### Backend

Add a logging module, for example `server/bwbk/interaction_log.py`.

Backend responsibilities:

- initialize schema and migrations
- allocate global log sequences transactionally
- create and heartbeat `log_sessions`
- create and close `text_contexts`
- mark stale crashed-session runs abandoned on project open
- expose logged generation endpoint
- record exact forwarded request JSON
- append candidate text updates while proxying SSE
- provide immutable ordered JSONL export
- provide generation-centered JSONL export

Generation should flow through one logged endpoint so the request captured in
`forwarded_request_json` is exactly the request sent to TabbyAPI.

### Frontend

Add a logging client module, for example `client/src/interactionLog.ts`.

The app should keep logging state separate from node state:

```ts
type ActiveLogState = {
  sessionId: string;
  activeContextId: string;
  activeSnapshotId: string;
};
```

Wire logging into:

- project open/create
- project close
- `commitBuffer`
- `onGenerate`
- streaming chunk handling through the logged backend endpoint
- `onCancel`
- autocomplete request start
- autocomplete normalization/dedupe/visible changes
- autocomplete dismissal
- autocomplete insertion
- Compose candidate insertion
- Keep
- node/path selection
- branch picker clear/drop
- mode switches
- map delete/merge when they change the loaded buffer
- explicit project close

The UI label can remain "Use"; the event remains `generated_text_inserted`.

## Tests

Backend tests:

- schema creation on new and existing `.bwbk` files
- global `log_sequence` ordering across snapshots, runs, updates, and events
- sessions heartbeat and stale-session cleanup
- project open marks only stale-session streaming runs abandoned
- text context open/close rows are explicit
- text snapshots append at every boundary, including unchanged text
- context load creates `parent_snapshot_id = NULL`
- child snapshots link within the same context
- candidate ids are returned before any candidate is displayed
- generation endpoint records exact `forwarded_request_json`
- parsed forwarded request prompt equals `prompt_text` for completion-shaped
  requests
- candidate updates append in order and maintain final candidate summary
- stopped streams preserve partial text
- system-cancelled streams preserve partial text
- ordered JSONL export excludes mutable run/candidate summary fields
- generation-centered export includes explicit context snapshot range

Frontend tests:

- Compose generation records full editor text, selection, prompt, and request
- stopping Compose logs `stop_stream` and preserves partial candidates
- clicking "Use" logs `generated_text_inserted`
- insertion offsets reproduce the after snapshot text
- repeated candidate insertion records distinct before/after snapshots
- insertion into a non-empty selection records replacement offsets
- editing after insertion creates a later child snapshot at the next boundary
- Keep logs only after hidden-node creation succeeds
- autocomplete logs full editor snapshot and trimmed prompt separately
- autocomplete logs visible suggestion metadata
- inserting autocomplete while streaming records `generated_text_inserted` and
  system cancel
- dismissed autocomplete distinguishes visible dismissal from no-visible-output
- autocomplete replaced by typing records events and transport cancellation
- node selection logs `before_context_switch` and `context_loaded`
- map delete/merge that changes the loaded buffer closes and opens contexts
- mode switch to map with dirty buffer records `node_commit`
- exports do not require mutable node ids

## Invariants

- Every logged object that represents an occurrence has a unique
  `log_sequence`.
- `log_sequence` defines total order across the interaction log.
- Every log session has a creation `log_sequence`.
- Every text context has a creation `log_sequence`, exactly one opening
  snapshot, and at most one closing snapshot.
- Every text snapshot records full editor text, selection, and offset units.
- Every workflow boundary appends a text snapshot.
- `project_opened` and `context_loaded` snapshots have
  `parent_snapshot_id = NULL`.
- Child snapshots point to snapshots in the same `context_id`.
- Every generation run has exactly one editor snapshot.
- A run-start snapshot precedes run creation and has a reason matching the run
  kind.
- For completion-shaped requests, parsed `forwarded_request_json.prompt` equals
  `prompt_text`. The exact raw forwarded request body remains the source of
  truth.
- Every generation candidate belongs to exactly one generation run.
- Every generation candidate has a creation `log_sequence`.
- Every candidate text update candidate belongs to the update's run.
- Candidate text updates have contiguous increasing `chunk_index` values per
  candidate.
- Each candidate update's `accumulated_text` equals the prior accumulated text
  plus `appended_text`.
- Candidate summary `final_text` equals the latest update's
  `accumulated_text`.
- Every candidate-related UI event has `run_id` and `candidate_id`.
- Interaction event `candidate_id` belongs to `run_id`.
- Every context-related event has `context_id`.
- Event snapshots are ordered:
  `before_snapshot.log_sequence < after_snapshot.log_sequence`.
- Generated-text insertion event snapshots are in the same context, and the
  after snapshot's parent is the before snapshot.
- Insertion offsets reproduce `after_snapshot.text` from
  `before_snapshot.text` and `inserted_text`.
- Terminal run status summaries are immutable after the terminal event is
  written.
- Every terminal run status transition has a `run_status_changed` event.
- Every terminal candidate status transition has a `candidate_status_changed`
  event.
- Keep events are written after hidden-node creation succeeds.
- Log tables use no durable references to `nodes.id`.
