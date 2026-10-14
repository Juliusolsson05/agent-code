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
