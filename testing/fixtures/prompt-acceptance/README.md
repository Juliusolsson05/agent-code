# prompt-acceptance

Recorded transcript entries that Claude committed for a prompt Agent Code
delivered, paired with the exact bytes Agent Code wrote.

These exist because **no transcript witness is ever equal to the sent bytes**:
Claude's composer rewrites what it ingests (tab expansion on paste, NFC
normalization when typed through its Cursor, image pills, and — since 2.1.278 —
a `<pasted_content id="…">` envelope around anything it treats as a paste).
`claudeSession.resolvePromptAcceptance` has to reconcile the two, and every
loosening of that comparison is a correctness risk, so each one is fenced by a
real recording rather than by a literal someone typed.

Each file carries the source transcript and uuid so the recording can be
re-read at its origin, and `claudeCodeVersion` so a future mismatch can be
bisected against the CLI that produced it.

| file | what it records |
|---|---|
| `pasted-content-envelope-2026-09-19.json` | #1052. A goal-loop continuation (2637 chars) delivered at 02:26:56.986Z and accepted 117 ms later, committed inside `<pasted_content id="cade">` … `</pasted_content id="cade">`. The matcher starved on it, timed out after 20 s, and reported `retrySafe: false` for a prompt the agent was already answering — which paused the goal loop at continuation 1 with `continuationsDelivered: 0`. `deliveredPrompt` was verified byte-identical to `buildGoalLoopContinuationPrompt` rebuilt from the persisted loop record, so the envelope is provably the only difference. |
