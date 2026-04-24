# Branching Workbook — Functional Specification

## 1. Design introduction

Branching Workbook is a personal creative-writing tool built around a tree of text. At any point in a draft, the user can fire a request that produces N divergent continuations side by side. The user picks one, composes their own from pieces of the generated candidates, or writes something entirely new. The tree records every path taken, and the user can navigate back to any earlier point and explore a different direction without paying the cost of re-prefilling the model's KV cache from scratch.

The system is a **client application** that speaks to **TabbyAPI** as its inference backend. TabbyAPI is the official OpenAI-compatible server for ExLlamaV3; it exposes the samplers we need (including DRY, XTC, dynatemp, all ooba-style samplers), fans out `n > 1` completions as concurrent batched jobs, inherits ExLlamaV3's content-addressed cross-job prefix reuse, has a built-in HuggingFace model downloader, and supports the HF-Transformers Jinja-template approach to chat framing if we want it. An earlier draft of this spec called for a custom server on the grounds that the OAI protocol was "the wrong shape" for branching generation, but on investigation TabbyAPI's implementation is actually a good fit: N concurrent jobs, interleaved streaming with per-branch `index`, disconnect-triggered cancellation, all of it works out of the box.

The user's hardware target is an H200 running a 120B-class model at roughly 4 bpw with a Q6-quantized KV cache. Rough capacity math: weights occupy ~70 GB including output layer and workspace, leaving ~65 GB of the H200's 141 GB for KV cache, which at ~135 KB per token of Q6 KV amounts to on the order of 500K cached tokens. That is generous enough that cache exhaustion is unlikely for a single-user workflow.

Connection between the laptop and GPU host is over an SSH tunnel. TabbyAPI binds to localhost on the GPU host; the laptop opens a local forward such as `ssh -N -L 5000:127.0.0.1:5000 user@host -p port`, and Branching Workbook connects to the forwarded local URL. The React client talks to the local FastAPI wrapper under `/api/*`; the wrapper handles SQLite project persistence and thinly proxies TabbyAPI calls through the tunnel. All GPU traffic is SSH-encrypted; authentication is the user's SSH key. TabbyAPI's own bearer/admin-token auth can be configured for non-tunnel deployments but is not required for the recommended SSH workflow.

The rest of this document is organized around the abstractions that carry weight: the data model (section 3), the generation semantics (section 4), and how the client maps its operations onto TabbyAPI's endpoints (section 6). Cache behavior (section 5) is inherited from ExLlamaV3 and documented rather than designed. The UI (section 7) is deliberately sketched rather than fully specified, because the user expects to iterate on it heavily once the underlying primitives are working.

The user does not have any explicit technology requirements, but is most familiar with python.

## 2. Goals and non-goals

**In scope for v1**

A single-user local creative-writing client with tree-structured branching generation, backed by stock TabbyAPI. Fan-out of N parallel continuations from any point in the tree, streamed concurrently into a picker view with interleaved per-branch output. Buffer-authoritative editing — the user's text buffer is the source of truth, and the tree is reshaped to match edits rather than constraining them. Manual composition ("write your own" branch box, and free-form copy-paste amalgamation into the buffer). Cross-job prefix reuse so that navigating back to earlier points in the tree does not re-prefill shared context (provided by ExLlamaV3's default page-table behavior via TabbyAPI). Keyboard-first interaction. Model loading and HuggingFace model downloading via TabbyAPI's existing endpoints, surfaced in the client UI.

**Explicitly out of scope for v1**

Multimodal input. Collaborative editing. Git or version control integration. Mobile UI. LoRA or adapter hot-swapping. Model swap mid-session (one model per session, restart TabbyAPI to swap). Speculative decoding. Cross-session KV cache persistence (sessions start cold, always). Per-branch sampler configs (all N branches in a fan-out use the same sampler; distinctness comes from sampling noise). Per-branch cancellation mid-stream (stop-all or wait-for-all, no per-branch stop). Export formats beyond plain text of a single branch. Import from files (paste-only for bringing in existing text). Search. Chapter or outline structures. Markdown or rich-text formatting. Auto-summarization of context that exceeds the model's window. Undo across sessions. Author's notes, lorebooks, character cards. Multi-user awareness. A custom inference server — we use stock TabbyAPI as-is.

**Out of scope, flagged for v2 consideration**

Search (full-text across a project). Chapter marks and outline view. Speculative decoding. Model hot-swap.

## 3. Data model

### 3.1 The buffer-authoritative principle

The tree is derived from text, not the other way around. The user works in a text buffer. When they type, paste, delete, or navigate, the tree is reshaped to match. This inverts the usual "the tree is structure, text is content" relationship found in most tree-based creative writing tools, and it is load-bearing for the entire design.

Concretely: when the user commits a change (by clicking generate, or by explicit "save" action, or by navigating away), the client computes the longest common prefix between the buffer and the existing active path. That common prefix identifies the nearest ancestor node. Any text beyond the common prefix becomes a new node (or chain of nodes) attached to that ancestor.

The algorithm, stated once for all edit types:

1. Let `buffer` be the user's current text and `active_path` be the concatenation of text from root to the currently-selected leaf along the main path (or current spine if no main path).
2. Find the longest prefix `P` such that `buffer[:len(P)] == active_path[:len(P)]`.
3. Identify the node `N` in the active path whose end-of-text position is equal to `len(P)`, or if `len(P)` falls strictly inside some node's text, split that node at `len(P)` to produce a new node `N` ending exactly at `len(P)`. The split is a structural operation: the original node is replaced by two nodes, first-half as a new user-written node and second-half reparented as its child, preserving all descendants.
4. Any buffer content beyond `len(P)` (the divergent suffix) becomes a new user-written child of `N`. If a divergent suffix already exists in some sibling of `N`'s existing children that exactly matches, attach to that sibling instead (no duplicate nodes for identical text).
5. The old active leaf, if it differs from the new leaf, is now on a sibling branch. It is not deleted; it just isn't on the currently-selected path.

Edge cases to walk through explicitly.

**Pure append.** User has a 10,000-token active path and types 500 additional tokens at the end. Common prefix = 10,000. `N` is the current leaf. New user-written child attached with 500 tokens of content.

**Delete from the end, type new text.** User has 10,000 tokens, deletes the last 1,500, types 200 new. Common prefix = 8,500. `N` is whichever node ends at offset 8,500, or an existing node is split to create one. New user-written child with 200 tokens. The original text beyond 8,500 (the deleted 1,500) is retained as a sibling branch; nothing is lost.

**Delete into an ancestor, type new text.** User has 10,000 tokens with branching structure, deletes back to offset 6,000 (cutting through multiple nodes), types 300 new. Common prefix = 6,000. If offset 6,000 falls inside a node, that node splits. The original structure beyond 6,000 (both the direct descendants and any branches that existed below them) is preserved as a sibling branch rooted at the split point. The new 300 tokens become a new user-written child.

**Edit in the middle of a node.** User has an ancestor containing "The cat sat on the mat." at offsets 3,000–3,023, and changes "mat" to "chair" without touching anything else. The buffer reads correctly up to offset 3,019 ("the "), then diverges. Common prefix = 3,019. The ancestor splits at 3,019, everything downstream of the change (including the tail "mat." of that node, plus any descendants that followed) becomes a sibling branch, and the user's edited continuation becomes a new child. This is "editing" semantically but structurally just branching — the old version is preserved, not destroyed.

**Edit that happens to recreate an existing sibling.** User types something that, after matching, turns out to be identical to an existing hidden branch created earlier. Rather than duplicating, attach to the existing branch. This keeps the tree from accumulating redundant nodes during experimentation.

**Paste replacing the whole buffer.** User selects all, pastes 50,000 tokens of a different draft. Common prefix = 0 (or just the beginning whitespace, depending on match). The tree gets a new user-written child of the root with the pasted content. The old content is still there, as a sibling subtree of the root.

**No-op edit that undoes itself.** User deletes 100 tokens, types them back identically before committing. No commit yet (the buffer matches the active path again by the time commit fires). Common prefix = full length. No tree change.

**Very small edits firing commits repeatedly.** Buffer-commit on every keystroke would thrash the tree. Commits are only triggered by explicit user actions: clicking generate, pressing save (keybinding), or navigating away from the current position. Typing alone is a pure client-side buffer modification that the tree does not see.

One subtle point worth making explicit: this algorithm means **edits are non-destructive by construction**. Every "edit" is actually a branch, and the original content is always retained somewhere in the tree (possibly as hidden branches). If the user wants actual destruction, that's a separate explicit "delete branch" operation that removes a node and its subtree from the tree entirely.

### 3.2 Node types

Every node has a `source` field with one of three values.

A **generated** node is produced by the model in response to a generate request. Its metadata records the sampler config, seed, and model identifier used.

A **user-written** node contains text the user typed or pasted. It has no sampler metadata.

A **composed** node is conceptually the same as user-written — text placed by the user — but with a hint flag indicating the text was assembled via copy-paste from multiple sources. This is purely informational for the UI (so it can visually distinguish "I wrote this from scratch" from "I stitched this together from generated candidates"); the system treats composed and user-written nodes identically.

### 3.3 Node schema

Each node carries:

- A unique ID (UUID).
- A parent ID (null for root).
- The node's own text content, stored as plain UTF-8 with no markup.
- `source`: generated, user-written, or composed.
- `hidden` boolean. Hidden nodes remain in the tree and on disk but are filtered out of default tree views. Used for branches the user didn't pick but doesn't want to outright delete.
- `main_path` boolean marking the user's current canonical path; at most one node per depth level can have this set, forming a single path from root to some leaf.
- Created-at timestamp.
- For generated nodes only: sampler snapshot (dict of temperature, top-p, etc.), seed, model identifier string.
- `prior_context_hash`: a hash of the concatenated root-to-parent text at the moment this node was created. Used to detect whether an ancestor was edited after this node was generated — if the current root-to-parent hash differs from the stored hash, this node was generated in a different context than it currently sits under. Computed as xxhash3-64 over the UTF-8 bytes of the root-to-parent string. xxhash3 runs at ~10 GB/s on modern hardware, so even a several-megabyte document hashes in sub-millisecond time; speed is not a concern. SHA-256 would also have been fine (hardware-accelerated at 1–3 GB/s), but xxhash3 is simpler and non-cryptographic hashing is sufficient here since we're identifying content, not defending against adversaries.

### 3.4 Tree size and tree view

There is no hard cap on tree size. The UI never renders the full tree — it renders a local view around the current position, specifically all ancestors up to the root and all descendants of the currently-focused node. Siblings of ancestors are shown as collapsed summary rows (node count, author, first few tokens) that the user can expand on click.

Hidden nodes are omitted from this view unless the user toggles "show hidden." Storage is SQLite per project, which scales to hundreds of thousands of nodes without trouble.

## 4. Generation semantics

### 4.1 The fan-out primitive

When the user clicks generate, the client sends a single HTTP request to TabbyAPI's `/v1/completions` endpoint with `n` set to the desired branch count, `stream: true`, a sampler configuration (shared across all branches), a max-tokens value, and the full prefix text in the `prompt` field.

TabbyAPI spawns N concurrent asyncio tasks, each enqueuing a `Job` into ExLlamaV3's `AsyncGenerator`. The generator's main loop runs per-job prefill followed by a batched decode step across all active jobs in a single model forward pass. Tokens stream back in a single SSE stream where each event carries an `index` field (0 through N-1) indicating which branch produced it.

All N branches share the same sampler configuration. Distinctness between branches comes from sampling noise — each branch has its own random state, so they diverge naturally at sampling time even with identical params. An earlier draft of this spec proposed per-branch sampler overrides; that capability isn't available through the OAI-shaped endpoint TabbyAPI exposes, and in practice running four branches at the same temperature and min-p produces more than enough variety.

### 4.2 How prefill actually works for fan-out

This is subtle enough to walk through explicitly, because a naive reading of "per-job prefill, batched decode" (the description of ExLlamaV3's main loop) suggests the shared prefix would be prefilled N times.

It isn't. Here is what actually happens for N=4 branches sharing a 10K-token prefix (about 40 pages at ExLlamaV3's 256 tokens per page), with nothing currently cached:

All four jobs enter the generator's `active_jobs` list in the same iteration (TabbyAPI enqueues them concurrently). The generator loop, per iteration, calls `job.prefill(...)` for each active job *sequentially*, then does one batched decode.

Before running any forward pass, `job.prefill()` consults the page table: "for the next chunk I need to prefill, are those tokens already cached?" If the answer is yes — identified by a content hash match — the job reattaches to the existing pages (incrementing their refcount) and skips the forward pass for that chunk. If no, it runs `model.forward()` and populates new pages.

Walking through iterations:

**Iteration 1:** Job 0's prefill runs first. Nothing cached yet. Runs forward on the first prefill chunk (say 2048 tokens = 8 pages). Those 8 pages are now in the page table with content hashes. Job 1's prefill runs next, same iteration: checks page table for the first 8 pages' hashes, finds hits (Job 0 just populated them), reattaches, skips compute entirely. Jobs 2 and 3: same.

**Iterations 2–5:** Each iteration, Job 0 prefills the next chunk, populates cache, and Jobs 1–3 hit and skip. After 5 iterations the full 40-page prefix is cached and all four jobs have their block tables populated.

**Total actual compute:** one prefill pass's worth of forward compute — Job 0's work. Jobs 1–3 contribute essentially zero compute, just hash lookups and refcount bumps.

**Total wall-clock:** cost of one prefill (1–3 seconds on target hardware for 10K tokens on a 120B model) plus small overhead from the dedup bookkeeping. Not instant like a combined single forward pass would be (vLLM-style), but not 4× either.

The sequential-within-iteration order is what makes the dedup work. If exl3 ran all jobs' prefills in parallel forward passes, all four would miss the cache simultaneously and pay 4× compute. Because they're serialized, Job 0's work populates the cache before Jobs 1–3 check it.

**One scenario where this reasoning breaks down:** if Jobs 1–3 entered `active_jobs` much later than Job 0, after Job 0's pages had been evicted (which requires significant cache pressure), they would each have to re-prefill from scratch. With 500K tokens of cache headroom on the target hardware and TabbyAPI's default `max_batch_size=256`, this scenario is extremely unlikely in single-user workflows.

### 4.3 Sampler presets

Sampler presets for v1 cover the full set TabbyAPI exposes to `/v1/completions`. Verified against live request-param logs from the TabbyAPI source:

- **Core truncation**: temperature, top-p, top-k, min-p, typical, top-a, TFS, skew
- **Dynamic temperature**: min_temp, max_temp, temp_exponent, temperature_last
- **Smoothing**: smoothing_factor
- **Anti-repetition**: DRY (dry_multiplier, dry_base, dry_allowed_length, dry_sequence_breakers, dry_range), XTC (xtc_probability, xtc_threshold, xtc_ignore_tokens)
- **Penalties**: token_repetition_penalty, token_repetition_range, token_repetition_decay, token_frequency_penalty, token_presence_penalty
- **Mirostat**: mirostat, mirostat_tau, mirostat_eta

The client doesn't need to understand each sampler's semantics — it just passes the values through. Sampler presets are user-definable name→config bundles stored in SQLite; the user maintains a library of presets ("Safe," "Wild," "Creative") and picks one per generate.

### 4.4 Streaming and the branch picker

The SSE stream from TabbyAPI delivers interleaved chunks from all N branches. The client routes each chunk to the appropriate branch panel in the picker view based on the `index` field. Each panel shows the accumulating text for that branch only.

Each streaming panel shows the generating text only — no per-branch stats, counters, or sampler summaries are displayed during generation. Minimal visual noise; this is creative writing, not benchmarking.

Alongside the N generated panels, the picker contains a **write-your-own** text box. The user can type or paste freely into this box at any time during or after generation. Committing requires clicking a submit button; the box is a buffer, not a live edit. Submitting the write-your-own box treats its contents as a composed node and advances the buffer to include it, exactly as if the user had picked a generated branch.

The user can copy text from any streaming branch (or from multiple branches) and paste it into the write-your-own box, edit, and submit. This is how amalgamation works in v1 — no special drag-and-drop or multi-select UI, just copy-paste into the compose box.

### 4.5 Stop conditions

Each branch stops when any of the following occurs: the per-call max-tokens limit is hit; a configured stop sequence is matched (passed through TabbyAPI's `stop` parameter); or the user triggers the global kill switch, which aborts the HTTP connection and causes TabbyAPI to cooperatively cancel all N branches.

Per-branch mid-stream stop is not supported — the OAI protocol has no mechanism for it, and the earlier design conceded this. "Stop all or wait for all" is the only mode.

Max-tokens is configurable per call, with a default set in user preferences. Stop sequences are configurable per session or globally.

Cancellation is cooperative — TabbyAPI polls for client disconnect during generator iteration. So aborting the HTTP connection doesn't preempt GPU work mid-prefill, but does cancel before the next decode step. In practice a stop is noticed within tens to hundreds of milliseconds.

### 4.6 What happens to non-selected branches

Generated branches the user did not pick are not deleted — they are inserted into the tree as siblings, marked hidden. They remain on disk and can be recovered via the "show hidden" view. The tree grows; the user's visible workspace does not. This is a deliberate hoarder-friendly design: hide rather than delete, because in creative writing a rejected continuation may become interesting again later.

### 4.7 Context window limits

When the assembled prefix (root-to-current) exceeds the model's configured `max_seq_len`, TabbyAPI will reject the request with an error. The client's UI shows a per-branch context-budget indicator (tokens used / tokens max) so the user has warning before hitting the wall. No auto-truncation, no sliding window, no summarization. The user deals with it manually — prunes the tree, starts a fresh project, or raises `max_seq_len` on next model load if the model supports more and VRAM allows.

## 5. Cache behavior

This section documents how the KV cache behaves through TabbyAPI and ExLlamaV3. There is no custom cache policy; we inherit ExLlamaV3's default page-table behavior. The content below is a description, not a design.

### 5.1 Mechanics

All KV cache lives on the **GPU**, in VRAM, not on the CPU. V1 has no CPU offload tier; under pressure, pages are reclaimed rather than paged out to RAM.

Within VRAM, the cache is organized via **paged attention**. A contiguous region of VRAM is divided into fixed-size pages. ExLlamaV3's page size is a fixed constant: **256 tokens per page**. Each page holds the K and V tensors for its 256-token span, at whatever cache quantization is configured (Q4, Q6, Q8, or fp16 — see section 9 on model loading). The cache is preallocated at construction time based on the `max_num_tokens` parameter of the `Cache` object; there is no dynamic growth. "Free" in the cache-status sense means "unreferenced logical pages," not "VRAM not yet allocated" — all VRAM is committed up front.

A sequence being generated holds a **block table** — an ordered list of page references — describing which physical pages back each chunk of its logical context. The page table tracks, for each physical page, its content hash (`phash`, a rolling hash chained from the previous page's hash) and its current reference count.

### 5.2 Cross-job prefix reuse

The behavior that makes "navigate back and continue" fast: when a job completes, its pages drop to reference-count zero, but they are **not immediately discarded**. They move from the `referenced_pages` map to the `unreferenced_pages` map, still indexed by their content hash. A later job arriving with a prompt whose page hashes match any entry in either map reattaches to those pages rather than re-prefilling them.

Concretely: when a new generate request arrives with a 10,000-token prefix, the server computes the rolling page hash for each of the roughly 40 full pages that prefix contains. For each page, the page table checks first `referenced_pages[phash]` (is this content still held by a live job?), then `unreferenced_pages[phash]` (is this content still sitting around evictable?). On a hit, the page is reused as-is, incrementing its refcount. Only pages with no match require prefill.

There is also a secondary, weaker reuse path for **partial final pages**. If the new prefix's final page contains, say, 150 tokens, and some existing page shares the same `prev_hash` and has 200 tokens of K/V already computed whose first 150 match, the prefill step will copy the matching 150 tokens' K/V from the existing page into the new one, rather than recomputing them. This is a micro-optimization that only bites at page boundaries but costs nothing when it doesn't help.

### 5.3 Eviction policy

When the page table needs to allocate pages and no free pages exist, it reclaims unreferenced pages in LRU order. Each page carries an `access_serial` — a counter updated to the current serial whenever the page is assigned to a job or reattached to one by content-hash reuse. When reclaiming, the page table sorts `unreferenced_pages` by `access_serial` ascending and pops the oldest.

"Oldest" here means "least recently assigned to or reattached by a job." A page that was generated five minutes ago but reused by a new job thirty seconds ago is newer than a page generated ten seconds ago that no job has touched since.

If every page is currently referenced (every page is in active use by a live job), new jobs cannot start. The generator's scheduling loop waits until some unreferenced pages become available. This is a genuine resource-exhaustion condition but unlikely to occur on the target hardware given the 500K-token cache headroom.

### 5.4 Practical implications for the tool

**Navigating back to an earlier point is free**, as long as nothing has evicted the relevant pages in the meantime. The common-ancestor prefix of the old and new positions was cached during earlier generation; reattaching it is just hash lookups. The divergent portion past the common ancestor may or may not be cached depending on whether the user is returning to a branch that exists in the tree (cached) or editing to produce novel text (not cached).

**Fan-out is efficient.** N jobs sharing a prefix deduplicate their prefix pages automatically via the same content-hash mechanism. Only the divergent suffixes use separate pages.

**The spine is not explicitly protected.** If the user steps away from a project for long enough and launches heavy unrelated work — say, firing many wide fan-outs in another part of the tree — the LRU could evict their spine's pages. The next generate against that spine would re-prefill. At 10K tokens on the target hardware, this is 1–3 seconds — acceptable. At 100K, tens of seconds — noticeable but not a catastrophe. On a single-user creative workflow with 500K tokens of cache space, this is an unlikely scenario in practice, but it is possible.

**There is no cross-session persistence.** When the server restarts or the model is unloaded and reloaded, the cache starts empty. Reopening a project means re-prefilling on first use. For a 10K-token spine that's 1–3 seconds on the target hardware; it scales linearly with spine length.

### 5.5 One nuance: recurrent models

For models with recurrent state (state-space models, hybrid architectures like Mamba variants), prefix reuse is capped at the longest prefix that also has a recurrent-state checkpoint stored in ExLlamaV3's `RecurrentCache`. This does not affect standard transformer models — dense or MoE — which are the user's target. Worth noting only because it means certain future model choices would interact differently with the cache.

### 5.6 User-visible cache state

No per-node cache indicator in the tree view. Cache residence is opaque and evolves invisibly. If a generate against a previously-visited position is slow, that's the visible signal.

**Cache-pressure readout in the status bar is cut for v1.** TabbyAPI does not expose `PageTable.num_unreferenced_pages` via its public OAI API, and the client shouldn't poke at internals across the SSH tunnel. If cache pressure starts mattering in practice, this can be added later either by contributing a `/cache/status` endpoint upstream to TabbyAPI or by running a small sidecar on the GPU host.

## 6. Backend: TabbyAPI integration

### 6.1 Transport

TabbyAPI binds to `127.0.0.1:5000` (its default port) on the GPU host, exposing no network-reachable interface. The user establishes an SSH port forward (`ssh -N -L 5000:127.0.0.1:5000 user@host -p port`) and the local FastAPI wrapper connects to the forwarded laptop port. All traffic is SSH-encrypted; authentication is the user's SSH key. TabbyAPI auth can be disabled for this workflow because SSH already authenticates the connection, or configured with a throwaway key for non-tunnel deployments.

HTTP with JSON bodies for control endpoints. Server-sent events (SSE) for streaming generation output and model-load progress. Both work cleanly through the SSH tunnel. In the current app, React calls local wrapper routes (`/api/completions`, `/api/tabby/model`, `/api/tabby/models`, `/api/tabby/model/load`, `/api/tabby/model/unload`, `/api/tabby/download`, `/api/tabby/token/encode`) and the wrapper forwards to TabbyAPI.

### 6.2 Statelessness with respect to user work

TabbyAPI holds exactly two kinds of state: the loaded model (with its ExLlamaV3 generator and page table) and currently-active generation jobs. It holds no knowledge of the user's tree, projects, preferences, or buffer contents. Every generate request arrives with the full prefix text TabbyAPI should use, in the `prompt` field. Every position the user might want to return to is just a text prefix from the server's perspective; the client is responsible for assembling that prefix from its tree.

This means closing the client and reopening it does not require any server coordination. TabbyAPI may be restarted between client sessions with no data loss — only the current session's warm cache is lost. Projects travel with the laptop; the GPU server is fungible infrastructure.

### 6.3 Endpoints used

All upstream endpoints below are TabbyAPI's own, documented at https://theroyallab.github.io/tabbyAPI/. Branching Workbook exposes them to the browser through equivalent local `/api/tabby/*` wrapper routes so the client remains same-origin and does not need direct knowledge of the tunnel URL.

**`POST /v1/completions`** — the core endpoint. The client sends:

```
{
  "prompt": <full root-to-current text>,
  "n": <branch count>,
  "stream": true,
  "max_tokens": <int>,
  "stop": [<string>, ...],
  "temperature": <float>,
  "top_p": <float>,
  ... (all other sampler fields from section 4.3 as applicable)
}
```

The response is an SSE stream of OpenAI-formatted chunks. Each chunk carries a `choices` array where each entry has an `index` field identifying which branch produced it and a `text` field with the newly-generated tokens. The client routes chunks to branch panels by `index`.

**`POST /v1/model/load`** — loads a model. Payload includes `model_name`, `max_seq_len`, `cache_mode` (FP16/Q8/Q6/Q4), and `tensor_parallel` flag if applicable. Returns an SSE stream reporting load progress.

**`POST /v1/model/unload`** — unloads the current model, freeing VRAM.

**`GET /v1/model`** — returns the currently loaded model's metadata.

**`GET /v1/models`** — lists all models in TabbyAPI's configured `model_dir`.

**`POST /v1/download`** — downloads a model from HuggingFace into `model_dir`. Payload includes `repo_id`, `revision` (branch or tag), and optional `folder_name`. Uses `huggingface_hub` under the hood; TabbyAPI can be configured to use `hf_transfer` for accelerated downloads (set `HF_HUB_ENABLE_HF_TRANSFER=1` in TabbyAPI's environment). Current TabbyAPI behavior ties the download task to the request: if the client disconnects, TabbyAPI cancels the download and cleans up partial files. Resume is available when issuing a new download request.

**`POST /v1/token/encode`** — encodes text with the loaded model tokenizer and returns token IDs plus `length`. Branching Workbook uses the local wrapper route for a debounced context-budget readout.

### 6.4 How prefix handling and cache reuse actually work

This was the section that initially looked like it should be in tension — "the server has no memory of the client's tree, yet navigating back is fast" — so worth walking through concretely.

Key fact: ExLlamaV3's page table is **content-addressed**, not session-addressed. Each cached page carries a rolling content hash (`phash`), and the page table maintains two hash-indexed maps: `referenced_pages` (pages currently held by live jobs) and `unreferenced_pages` (pages whose jobs have completed but haven't been evicted yet). A lookup by `phash` checks both. Any KV page whose content matches is reusable by any caller; the page table doesn't care which job originally populated it or who is asking now.

Walk through a request step by step.

The client assembles the full prefix text for the current buffer position — say 10,000 tokens worth. It sends this to `/v1/completions` with `n=4` and sampler params.

TabbyAPI spawns 4 concurrent jobs, each with the same 10K-token prompt. As described in section 4.2, the generator's main loop processes these jobs' prefill phases sequentially within each iteration: Job 0 populates cache pages with forward-computed K/V values, Jobs 1–3 check the page table, find Job 0's just-populated pages via hash match, reattach, skip compute.

Three possible outcomes for the prefill work overall:

**Fully cached** (all 40 page hashes match, e.g. because this prefix was generated minutes ago and nothing has been evicted). All 4 jobs reattach to existing pages. Essentially zero prefill compute.

**Partially cached** (common case — the user added text at the end, so the first 38 pages hit but the last 2 don't). Jobs reattach matching pages; 2 new pages get prefilled. Again, only Job 0 actually does the prefill compute; Jobs 1–3 see the newly-populated pages in the same iteration.

**Fully cold** (first request of a session, or the pages were evicted by intervening activity). No hits. Job 0 does the full 10K prefill in roughly 1–3 seconds at target hardware. Jobs 1–3 see Job 0's work populate the cache page by page and skip their own compute.

Once prefill is done, all 4 jobs decode in lock-step via batched forward passes. Tokens stream out through the SSE response, interleaved by arrival order with the `index` field identifying which branch each chunk belongs to.

The client plays no role in any of this cache logic. It sent text, got streaming output. It doesn't know or care which pages got reused.

**Why sending the full prefix every time doesn't waste compute.** The only per-request cost we avoid is the bandwidth of retransmitting the prefix over the SSH tunnel. That's tens of thousands of bytes per request — negligible compared to the prefill compute we *would* pay if the cache weren't there, and negligible compared to what the SSH tunnel can carry. The design choice to send the full prefix and rely on content-addressed cache hits is what keeps the server stateless without sacrificing performance.

## 7. UI functional requirements

The UI is deliberately underspecified in this document. The user has indicated it will need iteration, and what matters for the spec is that the underlying data model and protocol support the interactions the UI will eventually need. The following describes functional requirements — what the UI must allow the user to do — without prescribing exact layout or visual treatment.

### 7.1 Primary views

The UI has three major surfaces, simultaneously visible by default: a buffer view (the text), a tree view (the structure), and a branch picker (for active generation output). Layout is the implementer's choice; all three are first-class and should not be hidden behind tabs except at the user's explicit request.

### 7.2 Buffer view

The buffer view is a single editable text area that by default shows the full root-to-current-leaf path as one continuous string. The user can toggle to an alternate mode that shows only the current node's text with ancestors visible but not editable in a separate pane; toggling between these modes is keyboard-accessible.

Edits in the buffer are local to the client until the user commits (by clicking generate, by pressing a dedicated save key, or by navigating away). On commit, the buffer-authoritative logic of section 3.1 runs: compute the common prefix with the active path, reshape the tree as needed, persist to SQLite.

The buffer does not prefill the server's cache on edit. The server learns about buffer changes only on the next generate request.

### 7.3 Tree view

The tree view shows the current position's neighborhood: root-to-current ancestors, all descendants of the currently-focused node, and summaries of siblings of ancestors. The main-path-marked branch is visually distinguished (bold, color, or similar). Hidden nodes are omitted unless the "show hidden" toggle is on.

Clicking a node makes it the current position; the buffer view updates to show that node's root-to-leaf path. The user can mark any node as hidden (to clean up) or main-path (to mark canonicity) via a context menu and via keyboard shortcuts.

### 7.4 Branch picker

When generation is active, the branch picker shows N streaming text panels, one per branch, each with a stop button. Alongside them is the always-visible write-your-own text box with a submit button. The user can:

- Click a branch's text to read it in larger form (expand).
- Click a "select" button on a branch to commit it as the continuation (the branch becomes the new leaf on the main-path, siblings become hidden-but-kept).
- Type or paste into the write-your-own box (during or after generation) and click submit to use that text instead.
- Copy from any branch (or multiple branches) into the write-your-own box, edit, submit — the amalgamation path.
- Stop individual branches or all branches via the global kill shortcut.

### 7.5 Model loader

A dedicated view or modal where the user can:

- See the list of models currently present in TabbyAPI's `model_dir` (via `GET /v1/models`), with basic metadata.
- Select one, configure load-time parameters (max_seq_len, cache_mode, tensor_parallel), and load it via `POST /v1/model/load`. TabbyAPI returns an SSE stream with load progress; the client surfaces a progress indicator. While no model is loaded, generation is disabled.
- Unload the currently-loaded model via `POST /v1/model/unload`, freeing VRAM.
- **Download a new model from HuggingFace** via `POST /v1/download`: enter a repo ID (e.g. `turboderp/Llama-3.1-70B-exl3`), an optional revision (branch or tag, defaulting to `main`), and an optional folder name. TabbyAPI's downloader handles parallel file downloads. On completion the new model appears in the models list.

The download UI should make it obvious that downloads can take a long time (tens of minutes for large models). With current TabbyAPI, the request must stay open: closing the app, reloading, or otherwise disconnecting cancels the download and cleans up partial files.

**TabbyAPI configuration requirement:** For download acceleration, TabbyAPI's environment should have `HF_HUB_ENABLE_HF_TRANSFER=1` set and the `hf_transfer` Rust package installed. This is a server-side deployment detail, not something the client controls.

### 7.6 Interaction style

Mouse and keyboard. Buttons will be interfaced with by mouse click.

### 7.7 Status indicators

A single readout in the UI chrome (status bar):

- **Context budget**: current path's token count against the loaded model's max_seq_len. Visually warns when within 90% of the limit. The current implementation debounces calls to TabbyAPI's `/v1/token/encode` through the local wrapper; a local tokenizer cache can be added later if latency becomes a problem.

Cache pressure indicator is cut for v1 — TabbyAPI doesn't expose the underlying `PageTable` internals via its public API, and probing them through backdoor endpoints adds complexity for a cosmetic readout. If cache pressure becomes important in practice, either add it to TabbyAPI upstream or run a small sidecar.

## 8. Storage

### 8.1 Per-project SQLite

One project = one SQLite file on the user's laptop. The user picks a directory; the client creates and manages `.bwbk` (or similar extension) files there. Nothing user-global is ever written into a project file — some projects live in confidential folders and must stay self-contained.

### 8.2 Per-project schema sketch

```sql
CREATE TABLE project_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
-- e.g. ('version', '1'), ('created_at', '...'), ('title', '...'),
--      ('active_sampler_preset_id', '<uuid>')

CREATE TABLE nodes (
    id                   TEXT PRIMARY KEY,       -- UUID
    parent_id            TEXT REFERENCES nodes(id),
    text                 TEXT NOT NULL,
    source               TEXT NOT NULL,          -- 'generated', 'user_written', 'composed'
    hidden               INTEGER NOT NULL DEFAULT 0,
    is_main_path         INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    sampler_snapshot     TEXT,                   -- JSON, null for user_written/composed
    seed                 INTEGER,                -- null for user_written/composed
    model_identifier     TEXT,                   -- null for user_written/composed
    prior_context_hash   TEXT NOT NULL           -- xxhash3-64 hex
);

CREATE INDEX idx_nodes_parent ON nodes(parent_id);
CREATE INDEX idx_nodes_main   ON nodes(is_main_path) WHERE is_main_path = 1;
```

Samplers are stored as JSON blobs rather than normalized columns to keep the schema flexible as new sampler types are added.

### 8.2b User-global store

User preferences that should travel with the user — not the project — live in a separate SQLite file under the platform's app-support directory (via `platformdirs`):

- macOS: `~/Library/Application Support/bwbk/userdata.sqlite`
- Linux (XDG): `~/.local/share/bwbk/userdata.sqlite`
- Windows: `%LOCALAPPDATA%\bwbk\userdata.sqlite`

Schema:

```sql
CREATE TABLE sampler_presets (
    id          TEXT PRIMARY KEY,   -- UUID
    name        TEXT NOT NULL UNIQUE,
    body        TEXT NOT NULL,      -- JSON, superset of TabbyAPI sampler fields
    is_starter  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
```

Three starter presets (Creative / Balanced / Deterministic) are seeded on first init. The *active* preset id is per-project and lives in that project's `project_meta` under `active_sampler_preset_id`, so a confidential project's "which preset is active" choice never leaks into the global store.

Tests override the store location via the `BWBK_USERDATA_DIR` env var; production never reads it.

### 8.3 Persistence semantics

Every buffer commit (on generate, on navigate, on explicit save) writes to SQLite synchronously in a transaction. Autosave frequency: every commit, no periodic background saves. Crash recovery is whatever SQLite gives us — the journal handles partial writes cleanly.

### 8.4 What lives on the GPU server's disk

Nothing user-specific. The GPU host runs TabbyAPI with its own config file, the models directory, and whatever transient KV cache is resident for the current session. No project data, no tree state. If the GPU host is wiped, the user loses zero creative work — projects live on the laptop.

## 9. Operational behavior

### 9.1 Startup

TabbyAPI starts with whatever model is configured in its YAML (or nothing, if configured that way). The user connects the client, which queries `GET /v1/model` to learn the current state. If a model is loaded, generation is available immediately. If not, the user loads one via the model loader UI.

Client remembers the last project opened and reopens it on launch. If no project was open last time, shows a "new project / open project" screen.

### 9.2 Crash recovery

If TabbyAPI crashes mid-generation: in-flight branches are lost. The client detects the connection drop (SSE stream closes with an error), shows an error, and the user retries. The tree and all committed nodes are intact on the laptop's SQLite.

If the client crashes: since every commit is synchronously persisted to SQLite, the most that's lost is uncommitted edits to the buffer. On restart, the client reopens the last project in the state it was last saved.

If the SSH tunnel drops: requests fail until the user reestablishes the tunnel; otherwise nothing is lost.

### 9.3 Model swap

Not in v1. Swapping models requires unloading the current model and loading a new one, which discards the warm cache. Generated nodes in the tree retain their `model_identifier` metadata, so the user can always see which model produced what, even if they later load a different model. Mixed-model trees are allowed — nothing prevents the user from continuing a draft with a different model than the one that generated earlier parts; only the user can decide whether that's artistically defensible.

### 9.4 Logging

No logging beyond what's needed for debugging crashes. Generation params are stored per-node in the tree, which is the authoritative reproducibility record; no separate log is needed.

## 10. Implementation sketch

Not part of the functional requirements, but useful guidance.

**Backend**: stock TabbyAPI. Deploy it on the GPU host per its standard installation instructions. Set `HF_HUB_ENABLE_HF_TRANSFER=1` in its environment for fast model downloads. Configure `model_dir`, `cache_mode`, `max_seq_len`, and `max_batch_size` (default 256 is fine for our use) in `config.yml`. Bind to `127.0.0.1` only. No patches required for v1 functionality.

**Disposable GPU setup**: RunPod is one supported convenience path, not a product dependency. The desired RunPod experience is "start a pod, open one SSH tunnel, use the Branching Workbook UI to download/load models." This can be achieved with either a maintained TabbyAPI/ExLlamaV3 template or a small custom template/image. Any RunPod-specific scripts or template metadata should remain outside the core app and should not change the app's generic TabbyAPI-over-SSH boundary.

**Client**: React + TypeScript, served by Vite during development and talking to a local FastAPI wrapper under `/api/*`. The client is browser-only in v1, which is the fastest path to a working UI. Electron/Tauri wrapping is a later polish item.

**Database**: SQLite through the local FastAPI wrapper around stdlib `sqlite3`. Project files live on the laptop, one `.bwbk` file per project.

**Streaming**: `fetch` plus `ReadableStream` on the client side, because generation and model-load streams require POST bodies. Parse each SSE frame's `choices[i].index` field to route generation text to the right branch panel.

**Tokenization for context-budget UI**: the current implementation sends debounced token-count queries to TabbyAPI's `/v1/token/encode` through the local wrapper. A future optimization can load the model's `tokenizer.json` in the client via a JavaScript tokenizer library and cache tokenizer files locally per model.

The server-side tokenizer path is simpler and accurate for the currently loaded model. If latency becomes visible during editing, move to the local tokenizer cache.

**Sampler preset schema**: a JSON blob with fields matching TabbyAPI's request parameter names (see section 4.3). The client lets the user build presets through a form UI, stores them in SQLite, and merges the chosen preset into each generate request body.


## 11. Open questions and v2 candidates

Things noted during spec discussion but deferred.

**CPU RAM as a second cache tier.** Page out evicted KV pages to system RAM under pressure, page them back in on demand rather than re-prefilling. Would let the total warm working set exceed VRAM. Architecturally meaningful — the page allocator needs to understand two tiers and handle eviction-to-RAM vs eviction-to-oblivion distinctly.

**Speculative decoding.** Supported by ExLlamaV3 with a draft model. Would accelerate generation, especially useful when firing many branches. Deferred because it adds a second model to load and configure, and v1 is already broad.

**Model swap mid-session.** Requires deciding: when swapping, does the cache flush entirely, or do we attempt to preserve the tree-of-text while rebuilding cache against the new model? Latter is more useful but complex.

**Search.** Full-text search across all nodes in a project. Even simple substring match would be useful on large trees.

**Chapter marks and outline view.** Useful for long drafts.

**Disk-backed model metadata cache.** The `/models` endpoint enumerates directories, but parsing metadata for a large models directory could be slow. A simple on-disk cache of model metadata would help. Minor.
