# Codex: catalogue the wait continuation routes for plain tool results (#645)

Size: short. The root cause is known from the code and the corpus.

## Evidence (verified 2026-09-27, do not re-derive)
- `renderCodexOperation` (`src/providers/codex/renderer/rows/dispatch.tsx`, the `fromCodexWaitOperation` branch) renders a `wait` result with visible output as a named "Command continuation" row, receipt `codex.rows.dispatch` + `command.continuation`. An empty one is absorbed under the same owner and protocol. Both are deliberate.
- The catalog entry for the CUSTOM-output result envelope (`codex.tool-result.custom-tool-call-output`, `fp2-8571cc95`) lists both routes. The entry for the PLAIN result envelope (`codex.tool-result.tool-result.v1`, `fp2-5b0abcb6`) lists neither. So a plain `wait` result is classified misrouted: the audit's 45 sightings.
- Real corpus (`~/.codex/sessions`, all versions): `wait` runs as a plain `function_call` 3,232 times and `write_stdin` 9,578 times; their results are `function_call_output`. The rollout mapper turns those into a `tool_result` with no `codex.kind`, which is the `fp2-5b0abcb6` envelope.
- The frozen `rendering-bundles` corpus holds no such pair, which is why the default audit is clean. The August sightings came from session recordings that are no longer on disk.

## Decision
The renderer is right and the catalog omitted the routes (the doc's Stage 3 question 3). Add to `fp2-5b0abcb6` the same two `wait` routes its custom-output sibling has:
- `specialized` `codex.rows.dispatch` `command.continuation`;
- `absorbed` `codex.rows.dispatch` `command.continuation`.

This is not a lifecycle bug being silenced: the route is the dispatcher's deliberate rendering of a real, frequent result.

## Tests
- New recorded fixture `testing/fixtures/rendering-shapes/codex/wait/committed-function-call.json`: a real codex-cli 0.157.1 `wait` function_call plus its non-empty `function_call_output`, verbatim (ids and timings only, inspected end to end).
- The test maps the records through the real rollout mapper, checks the result fingerprint is `fp2-5b0abcb6`, routes the pair through `renderCodexOperation`, and classifies the sighting against the catalog. Red on main (`known-misrouted`); green after.
- The same check runs with the output emptied, for the absorbed route.

## Out of scope
The frozen audit corpus gains no new bundle; the fixture is attached to the catalog entry instead.
