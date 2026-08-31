# Prompt gate: stop blocking on settled compaction

Fixes #709.

## Problem

Every manual `/compact` on an idle Claude pane permanently blocks prompt
delivery ("prompt input is blocked by claude.compaction"). Three pieces, each
correct in isolation, compose into a deadlock:

- Claude Code leaves `⎿  Compacted (ctrl+o to see full summary)` painted above
  the composer, and on an idle pane nothing ever scrolls it away.
- `detectCompaction` truthfully reports that line as `visible, phase: 'done'`,
  and the compaction condition module forwards every visible phase into the
  snapshot.
- `derivePromptGateState` blocks on ANY snapshot condition — and compaction has
  no actions, so the block is `resolvable: false`: nothing can clear it, and
  because prompts are refused, no output can ever push the line off screen.

The persistent `Error during compaction: …` line latches identically.
Recorded in debug bundle `2026-08-31T01-07-29-510-6052830c`.

## Design: settled compaction is a fact, not a condition that gates input

Claude's own composer is demonstrably ready the moment the done/error line
prints (the recorded screen shows the empty `❯` prompt under it). Only a
RUNNING compaction describes a now-happening state — and it self-clears when
the line is replaced.

Fix at the gate, not the module/parser: `derivePromptGateState` gains a
blocking predicate — every condition blocks as before, except
`claude.compaction`, which blocks only while `phase === 'running'`. This keeps
the parser honest (it reports screen facts), keeps the condition strip and the
error-attention badge exactly as they are (the settled condition still exists
for UI), and confines the change to the one consumer whose semantics were
wrong. The gate lives inside the Claude provider, so per-kind knowledge is
already its business.

Rejected alternative: making the condition module return null for done/error.
Smaller diff, but it silently removes the strip and the `ERROR` attention
badge for settled states — a UI regression bundled into a gate fix, and it
bakes gate policy into a module whose job is detection.

## Tests

In `claudeSession.promptAcceptance.test.ts` (the existing fake-headless gate
harness): a snapshot holding the **recorded** done-phase compaction condition
(the exact literal from the bundle) must yield a ready gate; error phase also
ready; running phase still blocked; a trust-dialog condition still blocked
(pinning that the carve-out is compaction-specific).

## Verification

`tsc` node + web; the claudeSession suites under `NODE_ENV=development`.
