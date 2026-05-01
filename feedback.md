# Tree view & navigation feedback

This pass covers the tree pane and tree-driven navigation while in the compose view. Buffer editing, branch generation, sampler controls, and autocomplete weren't part of the audit and aren't covered here. Findings are grouped by how badly they break the user's mental model. Each entry says what happens, how to reproduce it, and why it matters in this app — most of these aren't generic polish notes; they tie back to load-bearing ideas in the spec (buffer-as-source-of-truth, hoarder-friendly deletion, the auto-name-from-content rule, etc.).

Probable bugs come first, then UX issues that aren't quite bugs, then smaller polish.

## Probable bugs

### Token counter doesn't update on path switches

The "X / 4,096 tokens" indicator in the top bar lags behind the active path. Selecting "stuff" yields a buffer of `testing stuff` (visibly two or three tokens) while the indicator reads 110. Selecting "Letter scene" gives a ~30-word paragraph with the indicator stuck at 209. Editing the buffer to add ~80 characters of text leaves the indicator at 0. The value usually catches up on the *next* unrelated interaction (an expand toggle, a click in the buffer) rather than on the path change itself.

Repro: from the seeded test project, click any chain node or leaf a few times in succession, comparing the buffer's visible content to the count in the top bar.

Why it matters: the meter is the only place the UI tells a user how close they are to the model's context limit. If it lags or stays stale, every prompt-engineering decision the user makes against it is a decision on bad data. When stitching long branches into a path and weighing whether to prune, the right value at the right time is the entire point of the meter.

### Run children render with two different visual conventions

A "linear run" chip (`X nodes · A → B`) expands two different ways depending on what's currently active. Expanding the "5 nodes 'test' → 'or 10'" run while a node inside the chain is active gives progressively-deeper indentation per descendant level, reading as a chain. Expanding the "2 nodes 'The wind pick…'" run while the active node is at or past the leaf gives every member at the same indent, reading as siblings.

Repro: select the leaf "or 10" and expand the first run, observe the staircase. Then select any node off the second run and expand it, observe the flat list.

Why it matters: the chip's label is identical between cases. The user has no signal that the visual structure changed, so the same underlying data reads as two different shapes. Anyone trying to build a mental model of the tree's topology will form different ones depending on which order they happen to expand things in. If progressive indent is right, both should use it; if flat is right, both should use it. The current behavior makes the tree feel non-deterministic.

### Active node disappears under filters and search

Enable "Show hidden", click a hidden italic node so it becomes the active path (the buffer reflects it), then turn "Show hidden" back off. The node vanishes from the tree but the buffer keeps its content. The same shape happens with search: while "stuff" is the active node, type "letter" into search; the tree filters down to root and the matching letter node, and "stuff" (the user's actual location) is gone from view.

Repro: as above. The filter case is especially easy to hit because clicking a hidden alternative was the recommended way to inspect them in the first place.

Why it matters: the tree exists to tell the user where they are in the project. When the active node disappears from the tree because of a filter the user just toggled, the user has no way to see their location and no obvious affordance to get back to it short of re-toggling the filter. Search should at least pin the active path into its result set as context, the way Finder always shows the file you have selected even when you're filtering. Better still would be a small "current node was filtered out" indicator with a one-click "show me where I am" action.

### No empty state for "no search matches"

Typing a string that matches nothing (`xyzzznothingmatches`) leaves the tree showing only the root. No "no matches" line, no count, no clear-search affordance more visible than the small × inside the field. The footer keeps reading "12 nodes" — its global count, unaffected by the filter.

Repro: search for any garbage string.

Why it matters: a user who didn't realize search was active, or who navigated away and back, sees a tree that just looks broken: one row, no chevron, no children. The "12 nodes" footer makes it stranger still, since it appears to claim the user has 12 nodes that have all simultaneously vanished. Either say "0 of 12 nodes match" or render an explanatory empty state with a clear "back to full tree" affordance.

### Clicking a non-leaf navigates to its leaf, but the bold lands on the clicked node

Clicking on "wind picked…" — a chain-start with a single child — updates the buffer to contain both the clicked node's content and its descendant's. The tree still bolds and active-marks the clicked node, not the leaf. So the visual "you are here" and the buffer's actual contents disagree.

Repro: in the seeded data, expand the second run and click "wind picked".

Why it matters: every interaction in this app is built around the buffer being the source of truth for the active path. If the active marker in the tree shows one node and the buffer represents a different node's content, the load-bearing invariant fails at exactly the place users will most often check. Either pick the clicked node and trim the buffer to it, or move the active marker to the leaf the buffer actually represents.

### Collapsed run chips can't navigate, only expand

Clicking the chip body, the chevron, or the "expand" link on a `X nodes · A → B` chip all do exactly one thing: toggle expansion. There's no click target on the chip that takes you to either endpoint. To navigate to the leaf of a collapsed chain, the user has to expand first, then click the leaf — two interactions for one destination.

Repro: any "X nodes" chip in the tree.

Why it matters: every other node in the tree treats clicking as "navigate". The most prominent affordance in the tree, with both endpoints written right on its surface, is the only thing that doesn't navigate. Reading "test → or 10" on a chip, the natural single-click meaning is "go to or 10," and that meaning is wasted on a redundant expand-toggle. Suggested split: click the chip body navigates to the run's leaf and auto-expands so the user can see where they landed; click the chevron toggles expansion without navigating; the redundant "expand"/"collapse" word on the right is dropped or merged into the chevron. This also matches the "click a non-leaf, end up at its leaf" rule that's already in effect for expanded run-start nodes.

### Cmd+Z crosses path-navigation boundaries

With "Letter scene" as the active node, hammering Cmd+Z several times in the buffer rewinds past the most recent edits and into content from a previously-visited *hidden alternative* path. The tree still shows "Letter scene" as active. The buffer shows different content entirely. Continuing to undo wipes the active node's content all the way to empty, at which point the app surfaces "Empty draft: the next save or generation starts a new path from root."

Repro: navigate around several paths (including hidden ones with "Show hidden" on), make any edit in the active node, then Cmd+Z repeatedly.

Why it matters: the spec is explicit that the buffer is the source of truth and that the tree reshapes to match. If the undo stack can put the buffer into a state that no node in the tree actually represents, that contract breaks at the most common keyboard shortcut a user has. The hoarder-friendly model also leans on "nothing is destroyed by normal user action," and silently undoing a node's content to empty is a hole in that promise. Suggested fix: scope undo per-node so it can't cross path switches, and refuse to undo past the start of a node's history rather than emptying it.

### Single-click on a tree node also focuses its inline name field

Clicking a tree row to navigate places focus in the row's inline name editor. The cursor visibly drops next to the node's label. If the user starts typing — for instance, intending to compose into the buffer — those keystrokes silently rename the node instead.

Repro: click any node, then type any letter without first clicking somewhere else.

Why it matters: this is a quiet data-corruption vector. The user's intent was to compose; they type a paragraph; they look up; they've renamed the node to "Once upon a time" instead of writing it. The compose pane already has its own "Untitled section" header for renaming, so the tree row doesn't need to do double duty. Tree-row clicks should navigate only and leave focus on the buffer (or at least off the name field).

## UX issues short of bugs

### Renaming the root via the tree row doesn't work

The root row visually invites renaming: there's a cursor-shaped indicator next to the label, and the rest of the tree's section names *can* be renamed through the compose pane's "Untitled section" header. Double-clicking the root navigates to it but accepts no rename input; subsequent typing is silently swallowed. Rename only takes effect through the compose-pane header.

Why it matters: the cursor affordance is a promise the UI doesn't keep. Users who try the obvious gesture first will conclude that root simply isn't renamable. Either wire the tree row up to do the same thing as the compose-pane header (and visually couple them so it's clear which is canonical), or remove the cursor-like affordance from the root row so users don't try.

### "Only starred paths" with zero stars is a no-op

Toggling the filter while no node is starred does nothing visible. The tree still shows everything, including unstarred runs and unstarred leaves. There's no message explaining the user just turned on a filter that had nothing to filter.

Why it matters: new users will conclude either that the filter is broken or that it doesn't do what its label says. There's no path from "I turned this on, nothing happened" to "oh, I need to star something first" without trial and error. Either disable the checkbox until at least one node is starred (with a tooltip such as "Star a node to use this filter"), or render an explicit empty state when it's on with no stars.

### Clicking a hidden node doesn't visually promote it

The italic-gray rendering for hidden alternative branches is a useful visual code, but the click handler doesn't update it. Clicking a hidden node sets the buffer to its content but leaves the row italic and gray. Only the previously-active row de-bolds slightly.

Why it matters: the "you clicked this and it became your location" feedback signal is missing exactly when the visual shift would be most useful — going from a normal node to a hidden one is a more dramatic context shift than going from one normal node to another, and the feedback should be at least as strong, not weaker. Right now users will wonder whether their click did anything.

### Run header counts don't match what expansion reveals

A "2 nodes · 'The wind pick…'" chip can expand to show three rows. A "5 nodes · 'test' → 'or 10'" chip breaks differently when its leaf is the active node. The user can't predict from the chip alone which counting convention applies.

Why it matters: counts only help if the user can use them to anticipate what they'll see. If a "2" sometimes shows 2 and sometimes shows 3, the user learns to ignore the count, which means the chip carries less information than its label promises. Either the count should match the row count after expansion, or the chip should make clear what it's counting (e.g. "links" vs. "nodes," or by using a chevron with no number).

### Footer "12 nodes" never reacts to filters

The bottom-left counter always shows the global tree size. Under "Only starred paths" with one star, it still says "12". Under search down to two visible items, still "12".

Why it matters: a number that never changes isn't telling the user anything actionable. Worse, when paired with a search that filters out almost everything, it implies "12 nodes match" rather than "12 total nodes exist". Either drop it (it's not actionable on its own) or contextualize it as "X visible · Y total" so the user can see at a glance how aggressive their filter is.

### Auto-generated node names start mid-token

Hidden alternatives get names like `, It's just a really awesome experience…` because the name-from-content rule slices the first N characters of the appended content, which can begin with whatever punctuation glued the branch onto its parent.

Why it matters: the auto-name rule is one of the nicer parts of the UI when it produces clean labels (`The wind picked up…`), but it loses that benefit the moment a leading comma or period turns the label into a fragment. Trim leading whitespace and punctuation when synthesizing the display name and the names will read as natural sentence starts.

### Save-state cluster is hard to differentiate

The bottom-right area cycles between `Save`, `Saved`, `Saving…`, and `Unsaved changes`. They render at similar visual weight, and the actionable "Save" state is distinguished from the inert "Saved" label only by a thin border.

Why it matters: the state worth noticing is "you have unsaved changes you can act on," and that's the one with the weakest visual distinction. Filled button vs. label, color shift, or any clear separation between the two would help. Right now it's easy to miss that there are unsaved changes at all.

### Compose section name uses contenteditable, not a real input

Pressing Cmd+A inside the section-name field selects the entire page (because the browser's default for contenteditable is "select all in the document"), turning half the UI blue.

Why it matters: a single-line rename field should behave like a single-line rename field. The current implementation feels broken when a normal keyboard shortcut produces page-wide visual chaos. Capture keydown on the contenteditable element and scope `document.getSelection()` to the field's range, or use a real `<input>`.

### Tree panel collapse/expand uses two different affordances

In the expanded state the toggle is a small `<` chip floating over the divider. In the collapsed state it's a vertical "TREE" label on the left edge.

Why it matters: they don't read as the same control, so reopening the tree after collapsing it feels like discovering a new feature rather than reversing an action. Use the same chip in both states (rotated, or with the chevron flipped) so the affordance is recognizable from either side of the toggle.

### Keyboard navigation on the tree

I didn't find any wired up. Tab from the buffer doesn't enter the tree, arrow keys don't move between rows, and the only way to focus a row is to click it (which then puts focus into the name editor; see the data-corruption note above).

Why it matters: if keyboard nav is intentionally out of scope for v1, that's fine — but the tree-row click also focusing the rename field makes mouse-only operation slightly worse than it has to be. At minimum, removing the auto-rename-focus would tighten things up regardless of keyboard plans.

## Edge cases and smaller polish

Long names without space-break opportunities (a long run of `A`s followed by a hash-like blob) flow off the right edge of the section-name field rather than wrapping or ellipsizing. Buffer-side it's fine. Probably not worth fixing unless URL-shaped names become common.

Setting an empty section name silently reverts to the "Untitled section" placeholder. Setting an empty root name reverts to the literal "root", erasing whatever name was there before. No toast, no confirmation. For sections this is reasonable; for root, dropping back to "root" without warning may surprise users who set it deliberately and then accidentally cleared it.

The buffer contains visibly duplicated sentences on certain paths in the seeded test data — for example, navigating through `wind picked → she hadn't meant` shows the same sentence twice in the rendered text. This may be a quirk of how the seed data was created rather than a defect, but it's worth a quick check that the branch-commit logic doesn't double-include leading text when a child's content overlaps with what's already in the parent.

Smaller cosmetic notes worth a sweep at some point: the chevron and indent positions on a row wobble slightly between expanded and collapsed states; tree-row star buttons have no visible hover or focus state while the compose-pane star does; the "expand"/"collapse" word on run chips reads like a separate button from the chip body but does the same thing.
