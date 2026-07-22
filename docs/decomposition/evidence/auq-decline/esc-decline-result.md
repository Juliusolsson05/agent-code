# Stage 1 evidence — the real Esc-decline `tool_result`

Captured 2026-07-23 by driving live `claude` v2.1.218 through node-pty: force
an AskUserQuestion multi-select picker, send **Esc**, then read the session's
JSONL transcript. (Transcript saving required stripping the inherited
`CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` markers, which disable
it.)

## What Claude writes when an AskUserQuestion picker is Esc-dismissed

The `tool_result` block paired to the AskUserQuestion `tool_use` id:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01Q1kUoojjwkH83cYvXi4B6D",
  "is_error": true,
  "content": "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."
}
```

Top-level `toolUseResult`: `"User rejected tool use"`.

## The load-bearing consequence

This is the **generic tool-rejection message**, identical for any declined
tool. It carries **no AskUserQuestion-specific signal** and **no indication
of whether the user abandoned the question or answered it via a follow-up
message**. The two cases are byte-for-byte indistinguishable in the
transcript.

Therefore "answered via message" rendering **cannot** be inferred from the
transcript. Plan B must set its own correlation marker (keyed by the AUQ
`operationId`) at the moment it performs the Esc + prompt, and feed that
marker to `ClaudeAnsweredQuestionRow`.

## What the renderer does with this today (to be fixed in Stage 4)

- `fromClaudeQuestionResult` returns `null` because `is_error === true`
  (`questions.ts:136`), so `answered = false`.
- `ClaudeAnsweredQuestionRow` shows the `◌` marker + *"response received —
  the unrecognized or failed result remains visible below"* and a generic
  error row renders the raw rejection text above.
- Separately, immediately after Esc (before this committed result arrives)
  the live plane briefly shows a green `✓` with an empty body, because
  `turn_stopped` (`foldEvent.ts:996`) stamps `resultAt` with no content.

Both must become "answered via message → <choices>" for a plan-B answer.
