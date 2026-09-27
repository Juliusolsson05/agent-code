# Codex exec_command results survive in resumed history (#1321)

## Evidence
- **Census of 2,541 local rollouts.** It found 85,355 `function_call_output` lines whose output is wrapped: `Chunk ID:`, `Wall time:`, `Process exited with code N`, `Original token count:`, then `Output:`. It found **0** `exec_command_end` events in any file.
- **Codex never writes that event.** codex-rs `rollout/src/policy.rs` puts `EventMsg::ExecCommandEnd` under "Transient, non-durable events".
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
