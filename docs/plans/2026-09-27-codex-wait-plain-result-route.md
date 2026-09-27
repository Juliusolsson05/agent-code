# Codex: catalogue the wait continuation routes for plain tool results (#645)

Size: short. The root cause is known from the code and the corpus.

## Evidence (verified 2026-09-27, do not re-derive)
- `renderCodexOperation` (`src/providers/codex/renderer/rows/dispatch.tsx`, the `fromCodexWaitOperation` branch) renders a `wait` result with visible output as a named "Command continuation" row, receipt `codex.rows.dispatch` + `command.continuation`. An empty one is absorbed under the same owner and protocol. Both are deliberate.
- The catalog entry for the CUSTOM-output result envelope (`codex.tool-result.custom-tool-call-output`, `fp2-8571cc95`) lists both routes. The entry for the PLAIN result envelope (`codex.tool-result.tool-result.v1`, `fp2-5b0abcb6`) lists neither. So a plain `wait` result is classified misrouted: the audit's 45 sightings.
- Real corpus (`~/.codex/sessions`, all versions): `wait` runs as a plain `function_call` 3,232 times and `write_stdin` 9,578 times; their results are `function_call_output`. The rollout mapper turns those into a `tool_result` with no `codex.kind`, which is the `fp2-5b0abcb6` envelope.
- The frozen `rendering-bundles` corpus holds no such pair, which is why the default audit is clean. The August sightings came from session recordings that are no longer on disk.

## Decision
The renderer is right and the catalog omitted the routes (the doc's Stage 3 question 3). Add to `fp2-5b0abcb6` the two `wait` routes its custom-output sibling has:
- `specialized` `codex.rows.dispatch` `command.continuation`;
- `absorbed` `codex.rows.dispatch` `command.continuation`.

The absorb route IS needed, and one revision of this PR got that wrong. Review b argued that the rollout mapper drops empty plain outputs (`!output.trim()`), so the absorb route had no real source, and that revision removed it. Review c then counted the corpus:
- **587 of 3,257 real plain `wait` results** are envelope-only. A still-running cell returns "Script running with cell ID N / Wall time … / Output:" with nothing after.
- **The mapper keeps that text**, because it is not empty.
- **The dispatcher's visibility check strips the envelope** and absorbs the result.

The route is restored and pinned from a second real 0.157.1 recording. Lesson: reachability is counted in the corpus, never inferred from one mapper branch.

Known residual (review a): the plain envelope carries no tool name, so the catalog cannot tell a `wait` result from any other plain result. A future dispatcher bug that tagged a non-wait plain result `command.continuation` would be classified `known-claimed`. Closing that needs invocation-aware fingerprints, which are outside this fix.

This is not a lifecycle bug being silenced: the route is the dispatcher's deliberate rendering of a real, frequent result.

## Tests
- New recorded fixture `testing/fixtures/rendering-shapes/codex/wait/committed-function-call.json`: a real codex-cli 0.157.1 `wait` function_call plus its non-empty `function_call_output`, verbatim (ids and timings only, inspected end to end).
- The test maps the records through the real rollout mapper, checks the result fingerprint is `fp2-5b0abcb6`, routes the pair through `renderCodexOperation`, and classifies the sighting against the catalog. Red on main (`known-misrouted`); green after.
- The test also renders the result row and asserts the "Command continuation" label and the recorded output's text (review a/b: the receipt alone survived label and content mutations).
- A second real recording, an envelope-only still-running `wait`, is mapped, absorbed by the dispatcher and classified `known-claimed`. Red without the absorbed alternate.
- The fixture also carries the mapped `cases` carrier that the catalog coverage gate (`shapes.coverage.test.ts`) sweeps. A test pins it equal to the mapper's output, so the gate and the tests read the same shapes.

## Out of scope
The frozen audit corpus gains no new bundle; the fixture is attached to the catalog entry instead.
