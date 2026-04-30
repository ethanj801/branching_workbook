## Bugs

**1. [BUG] Use inserts at position 0 if the editor was never focused after Generate.** Repro: load project → click Generate → click Use on any branch (without ever clicking into the editor first). The branch text lands at offset 0 of the buffer, jammed against the original first character with no separator. I produced "...something breaks.testing stuff" this way. The selection ref defaults to `{0,0}` until the editor takes focus. Either: focus the editor on mount, or fall back to `buffer.length` instead of 0 when no real selection has been recorded.

**2. [BUG] "Use instead" in strip mode appends instead of replacing.** Repro: empty buffer → Generate → Use Branch 1 → strip shows ✓ Branch 1 → hover Branch 2 → click "Use instead". Expected: Branch 2's text replaces Branch 1's range. Actual: Branch 2 is appended after Branch 1, leaving both in the buffer. I think the click is hitting the parent card button (which sets viewMode back to grid) before the inner Use button fires, killing the `canReplaceUsed` precondition. The whole point of the "Use instead" affordance is replacement, so this is a load-bearing bug.

**3. [BUG] Error banner "PUT /api/project/settings failed: 500" sticks around indefinitely.** Repro: Generate → toggle Display from cards to inline. The first toggle right after a Generate fires the failed PUT (likely a race — the project state hasn't fully reconciled). The banner has no dismiss button and only clears when *that exact endpoint* succeeds again, not when other API calls succeed. It looks alarming but is recoverable.

**4. [BUG] Inline ghost text doesn't invalidate on buffer edits.** While a ghost suggestion is showing, type characters at the end of the buffer. The ghost text follows the cursor but was generated for the *old* prompt — accepting it via Tab produces "...9 or 10 hello The wind picked up just as..." (suggestion that no longer continues coherently). Either dismiss the ghost on edit or restream from the new prompt.

## UX issues

**5. [UX] Inline mode pins ghost to end-of-document, regardless of cursor.** If the user clicks into the middle of the manuscript expecting a suggestion to continue from there, the ghost still appears at the very end. The code comment ("Inline compose pins insertion to the end") explains the *why* — but nothing in the UI hints at it. A subtle "→ inserting at end" label near the cursor cycler, or moving the ghost to the actual selection, would clear this up.

**6. [UX] Inline controls (Use/Keep/Clear/cycler) sit below the editor and scroll off-screen with a long buffer.** The Tab/Esc/Ctrl-]/Ctrl-[ shortcuts are listed in the same row, so power users are fine, but a discoverability cliff for new users. Pinning the controls to the bottom of the manuscript pane (above the model bar) would fix it.

**7. [UX] No clear indicator of which card was already Used in grid mode.** The picked card's Use button is disabled, but visually it looks identical to the other primary buttons (all dark). After Use the view collapses to strip and a ✓ appears there, but if the user expands back to grid (e.g. by clicking a strip card), they lose that signal. A "Used" label, an outline on the picked card, or a different button state would help.

**8. [UX] Hover-revealed action pills on strip cards overlay the title.** Keep / Use instead / Expand appear on top of the "Branch N" label and preview. The user can't read which branch they're acting on while the actions are visible. Either move the actions below the preview or shrink them.

**9. [UX] Branches input silently coerces invalid input to 3.** Empty, 0, or non-numeric values get clamped without any toast/error/border-red. The user might think their value of 0 took effect when it didn't. Same for typing "abc" — the input goes blank without explanation.

**10. [UX] Branches has no soft upper cap.** I asked for 50 and got 50 cards in a 5-column grid that scrolls internally. The cards section eats the manuscript area. A confirmation at large N (e.g. >12) or a hard cap with a tooltip would prevent thousand-mile-stare layouts.

**11. [UX] Editing the buffer empty and Generate-then-Save creates a node directly under root.** After Cmd+A → Delete → Generate → Use → Save, the new node attaches as a sibling of "test" rather than continuing from the previous active path. Technically defensible (you erased the path), but the tree implicitly resetting to root has no visible warning. A "starting from root" hint when the buffer is empty + a node is about to be created would prevent surprise.

**12. [UX] Cmd+Z does nothing if focus isn't already in the editor.** After clicking Use, focus stays on the button. Pressing Cmd+Z to undo "wait, that wasn't right" silently fails until the user clicks back into the manuscript. Either route Use to actually return focus to the editor (it does set selection but the focus call is in a rAF — possibly racing) or trap Cmd+Z at the document level when in compose mode.

**13. [UX] No visual "modified" indicator.** The Save button is always primary; no dot/asterisk/disabled state when the buffer matches the saved state. With a hoarder-friendly model where edits matter, this is more important than usual.

**14. [UX] No keyboard shortcut for Generate.** Tab/Esc/Ctrl-]/Ctrl-[ are bound but Cmd-Enter / Cmd-G isn't. For a creative-writing app where you'll fan-out hundreds of times in a session, this stings.

## Polish

**15. [POLISH] Card height is fixed regardless of content.** Short streaming text ("The wind picke", 4 tok) sits in a card sized for ~150px of text — lots of dead space.

**16. [POLISH] Branches all start with a leading space** (mock-server artifact, but visible in the cards as awkward indentation).

**17. [POLISH] The token counter "171 / 4,096 tokens" at top-right has no tooltip or label** explaining it's the assembled-prefix length vs `max_seq_len`.

**18. [POLISH] The model status dot toggles green→pale-green** without a hover explanation. I think it indicates idle/streaming, but had to guess.

**19. [POLISH] Cards-mode strip dismiss (×) clears the entire strip.** No way to drop a single branch from history.

**20. [POLISH] After narrow-viewport resize the tree pane went from fully expanded to showing only "root" + collapsed "test"** (with 10 nodes in the footer). I couldn't reliably reproduce — possible state desync between resize and tree expansion. Worth a quick look.
