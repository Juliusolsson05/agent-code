# Claude delivery rollback reads the attribute-aware composer state (#1291)

## Evidence
- Paste-debug journals: 4 `rollback-exhausted {presses: 64, restored: true}` against 1 `rollback-cleared`. Each exhausted case takes 6.7–8.6 s: 5 s absorption timeout, then about 0.4 s, then 64 × 25 ms of kills. The delivery then reports "still in Claude's composer — clear it there", and the gate reads `occupied`.
- Prompts: "yes fix all 9" (typical of a Claude prompt suggestion), "draft the WhatsApp message for Falco", and two long human messages (144 and 380 chars).
- `rollbackWrittenPrompt` classifies with `parseClaudeComposerState(screen, null)`, i.e. text-only. That path allowlists only two placeholder hints, and every other placeholder row reads as `drafted`. After a kill empties the composer, Claude repaints placeholder text (a suggestion, a hint), so the text-only read never becomes `empty`. The rollback presses 64 times and then yanks the prompt back: stranded.
- The prompt gate already avoids this. `claudeSession.derivePromptGateState` reads `headless.getComposerState()`, which classifies with cell attributes, so dim placeholder text is `empty`. The rollback bypasses it.
- No PTY frame of these moments survives. The proxy run was pruned, and feed-debug has no screen text. The mechanism is shown by the parser's two paths plus the outcome journals.

## Change
- `ClaudeSession.getComposerState()` exposes the headless's attribute-aware state, and `AgentSession` gets it as an optional capability.
- The rollback prefers it and keeps the text-only fail-closed read for sessions without it.
- The observe/kill/yank structure is unchanged.

## Test
A delivery whose composer shows prompt-suggestion text before and after the kill. The attribute-aware state goes `drafted` to `empty` after the first kill. The rollback must report `cleared` after 1 press, not exhaust 64. Red on main.
