# One line per MCP tool call (#1519)

**Size:** short plan. A provider-neutral model and row, admitted in Claude's dispatch after every specific card.

## Evidence (verified)
- **Frequency.** In the last 40 Claude transcripts, generic MCP calls are 885 of 6,251 tool calls (14%). The other gallery items were checked through the real dispatch and are already handled:
  - Write and Edit results are absorbed;
  - Skill is absorbed;
  - ToolSearch shows "Found N tools".
- **Current rendering.** Generic MCP call and result both fall back. That gives the name with an `MCP · server` chip, `▸ 1 param`, and `▸ ok: true`.

## Change
- **`protocols/mcp-call/model.ts`.** `fromMcpCall(toolUse, result)` returns `{tool, server, detail, outcome: pending|ok|refused|error|content, message, acknowledgement}`.
  - Only a whole-text `{"ok":true,…}` envelope counts as an acknowledgement.
  - An error or refusal sentence is ANSI-stripped and bounded.
- **`McpCallRow`.** `◆ tool  subject  verdict`, with the arguments one click away and the sentence under the line.
- **Claude dispatch.** The default branch admits any `mcp__*` call, after the specific cards. The result is absorbed for ok, refused and error (the line carries it); content keeps the shared row.

## Tests
Recorded calls in `testing/fixtures/claude-mcp-calls/samples.json`, read in full; private chats and provider instruction text excluded. They run through the real mapper and dispatch:
- acknowledgements are absorbed;
- error and refusal sentences are shown, with ANSI stripped;
- a pending call shows `◌`;
- content falls back.

The tests fail without the dispatch change.

## Boundary
The app was not launched.

## Review round (one round, two reviewers)

### Fixed
- **Blocker (A1 / B1).** `ok:true` is Agent Code's success envelope for nearly every tool, reads included, so treating it as "nothing to show" hid payloads. The line now absorbs a result only when one of these holds:
  - it is a true acknowledgement: Agent Code's own server, a single text part, and keys ⊆ {ok, text, updatedAt, revision, completedAt}, the recorded goal_set/tldr_update shape;
  - it is an error or refusal, whose full text the line's disclosure holds.

  Any other ok result gets ✓ and keeps its row: reads (`browser_console`, `usage_read`, transcripts), third-party replies (A3), and images (A4).
- **A2.** An Agent Code orchestration, workspace or workflow call whose own card declined keeps the visible generic fallback.
- **A5 / B7.** The disclosure holds the full error or refusal text, bounded with a truncation marker. A refusal shows its code.
- **B2.** A committed call with no result shows no "running" glyph.
- **B3.** The server chip truncates first.
- **B4.** A user's decline or interrupt reads as "declined", not as an error.
- **B6.** Verdicts have screen-reader words.
- **B8.** Parsing is bounded: acknowledgements under 4 KB, and the detail scan capped.
- **B10.** The server name comes from `RESERVED_USER_MCP_NAMES`.

### Tests
Mechanical mutations of the recordings: a read payload, a third-party reply, an image part, the error disclosure, the arguments disclosure, a committed orphan, a decline, a drifted orchestration call, and screen-reader text. 16/16 pass, and 501/501 across claude and shared.
