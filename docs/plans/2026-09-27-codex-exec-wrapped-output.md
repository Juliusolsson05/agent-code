# Codex exec_command results survive in resumed history (#1321)

## Evidence
- **Census of 2,541 local rollouts.** It found 85,355 `function_call_output` lines whose output is wrapped: `Chunk ID:`, `Wall time:`, `Process exited with code N`, `Original token count:`, then `Output:`. It found **0** `exec_command_end` events in any file.
- **Current Codex never writes that event.** codex-rs `rollout/src/policy.rs` puts `EventMsg::ExecCommandEnd` under "Transient, non-durable events". rust-v0.107.0 through v0.136.0 did persist it in extended-history mode (review a), and none of the local rollouts use that mode.
- **The drop rule.** `mapCodexRolloutToFeedEntries` drops every wrapped output that has an exit line (`isCodexExecWrapperOutput`), on the stated belief that "the correlated `exec_command_end` event carries the same result". That belief is false, so the dropped line was the only copy. Every `exec_command` card in resumed history showed no output and no exit status. That covers Codex through 0.144: `exec_command` wrapped outputs occur in 0.1xx through 0.144, and 0.15x uses the `exec` tool.
- **A second bug.** The predicate searched the WHOLE string for "Process exited with code". A still-running chunk whose command output contains those words was dropped too.

## Change
- **Header-only parsing.** `codexExecWrapperExitCode(output)` reads the exit code from the header only, the part before `\nOutput:\n`. It returns null for unwrapped output and for a still-running chunk.
- **Keep the result.** A wrapped, finished output now maps to a tool result with:
  - the stripped output (possibly empty);
  - `is_error = exitCode !== 0`;
  - the same `codex` metadata the event branch produces (`kind: 'exec_command_end'`, `exitCode`, empty `parsedCmd` and `command`, null `cwd`).

  So the command adapter reads it as the native transport it is: exit-proven, the output owned, and an empty success absorbed by the row dispatcher as before.
- **Comments corrected.** The stale comments that say the wrapper comes from, or is duplicated by, `exec_command_end` are fixed.

## Tests
`execWrappedOutput.test.ts` runs three real 0.132.0 pairs (exit 0 with output, exit 1, exit 0 with no output) through the real mapper and the real `fromCodexCommandOperation`, plus a still-running chunk whose body contains the exit words. All four are red on main.

## Not in scope
The 0.15x `exec` tool's `custom_tool_call_output` results are a different carrier, already handled by the code-mode envelope path.

## Review a (round 1)
- **P1: a running chunk read as a success.** A wrapper whose header says "Process running with session ID N" is a partial chunk. The command's exit arrives on a later `write_stdin` result with another call_id. The adapter's native branch claimed `exitProven: true` for every result, so the card said success. The mapper now marks such a chunk `codex.kind: 'exec_command_running'`, and the adapter does not claim a proven exit for it, so it shows `unknown`. A first attempt, "no exit code means unproven", also flipped synthetic Git-formatter test results that carry no metadata. The explicit mark keeps the change to the one shape the review found. Correlating the later `write_stdin` exit back to the card by session id is a separate feature, not done here.
- **P2: two carriers.** In extended-history rollouts, one call can have both the event and the wrapper. `createCodexTranscriptEntryMapper` keeps the first exec terminal result per call_id, remembering the last 512 per stream. A pair split across a history page boundary is not caught.
- **P3: no `Output:` marker.** Without the LF `\nOutput:\n` marker the wrapper is not parsed, so no exit claim and no stripping. None of the 85,355 local wrappers lacks it.
- **Unpinned metadata.** The exact `codex` metadata is now asserted, which kills the kind/parsedCmd/command/cwd mutations.

## Review b (round 2)
- **P2: a wrapper with no LF `Output:` marker still painted success.** The mapper returned a plain, metadata-less result, and the native adapter proves every unmarked result. Any `Chunk ID:` wrapper whose header cannot be parsed is now marked `exec_command_unparsed` and kept whole; the adapter shows `unknown` for it, as for `exec_command_running`. Test: that wrapper, through the adapter, shows `unknown` with a null exit.
- **P2: first-carrier dedupe kept the truncated event.** The persisted event's `aggregated_output` is sanitized to 10,000 bytes, and extended mode persisted it through v0.136.0, not v0.131.0. The wrapper now wins. An event that arrives after its wrapper is dropped. A wrapper that follows its event is kept, and later-wins `buildToolResultIndex` hands the card the wrapper. Codex emits the event before the function result (`ToolEventEmitter::finish`).
- **P2: page and burst boundaries bypass the per-mapper memory.** Accepted and documented. Across a boundary both results are kept and later-wins decides, which again favours the wrapper in Codex's emit order. No local rollout has both carriers.
