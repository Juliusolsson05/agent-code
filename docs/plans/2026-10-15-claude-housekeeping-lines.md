# Claude housekeeping tool calls as one line (#1522)

Short plan, stacked on #1520 (the MCP line). The shape is known: it is the same line model.

## Outcome
Monitor, SendUserFile and TaskStop render as `◆ <tool>  <subject>  <verdict>`. A recognised acknowledgement absorbs its result row; the full text stays one click away. An error shows its sentence. Any result the line does not recognise keeps the shared result row.

## Change
- `src/providers/claude/renderer/adapters/housekeepingLine.ts`: `fromClaudeHousekeepingLine(toolUse, result, {live})` → the shared `McpCallModel` (server '', ownServer true). It uses a per-tool table: which input field is the subject, and which result text is the acknowledgement.
- `McpCallRow`: no server prefix when `server` is empty.
- Claude dispatch: the default branch tries the housekeeping line before the MCP line. The result branch absorbs only when `absorbsResult`.

## Tests
`housekeepingLine.renderer.test.tsx` runs on `testing/fixtures/claude-housekeeping/samples.json`: recorded, with the Monitor result mechanically cut (labelled in the fixture). It checks that every ack is absorbed with the right subject, including SendUserFile's path-list form; that the TaskStop error is shown; and that for each tool an unrecognised result, a non-text result, or one longer than the disclosure keeps its row.

## Verification boundary
No app launch. tsc on both projects, plus the scoped renderer tests.

## Ruling
Skill and ScheduleWakeup are dropped from scope: the task-activity card (adapters/tasks.ts) already owns them and runs first in dispatch. This was found by the first test run. Cost if wrong: none; they keep their existing card.
