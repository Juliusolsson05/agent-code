# Antigravity native terminal

**Status** — Native prompt and both view transitions verified locally. The release containing this change is pending.
**Approval mode** — The owner requested native agy and authorized staged implementation. Revisit scope with the owner if a solution requires changing their agy settings, submitting a model turn, or modifying the provider's private conversation store.

## Starting point and outcome

Agent Code 0.1.9 could drive agy through ACP. That proved the rendered conversation worked. It exposed no interactive terminal for this provider. The owner wants the real prompt inside an Antigravity pane. Terminal should accept native keyboard input, resizing and local commands. Agent view must still render ACP. Opening or changing views must follow the chosen conversation when two panes share a directory. If a handoff fails, the original pane should remain usable.

## Stage 0 results

The opt-in [registry-to-prompt probe](../../testing/live/antigravity-terminal.test.ts) exercised the installed macOS CLI through the production provider registry. Two signed-in panes opened in the same directory with distinct IDs. One pane displayed a typed draft, cleared it, ran the native local command `/new` and acquired a third ID. The probe reopened that ID in ACP, then reopened the native prompt while ACP was still running. It submitted zero model prompts. These are observed cases, not a population estimate.

| Hypothesis | Observation and verdict |
| --- | --- |
| H1. The CLI lacks a terminal interface. | Disproven. The installed CLI painted its own interactive prompt and accepted keyboard input. The restriction belonged to the host. |
| H2. A pane's directory identifies its conversation. | Disproven. The two panes shared a directory and had distinct IDs. |
| H3. An interactive process starting proves it resumed the requested conversation. | Disproven. With one nonexistent ID agy stayed alive and reported that it could not find the conversation. |
| H4. A pane can follow changes inside agy without reading its conversation content. | Observed on this CLI. The native `/new` action emitted a process-local active-conversation record naming the new ID. Other diagnostic records mention unrelated IDs. |

## Verification stages

| Boundary | Produces | Independently verified by | Why separate | Real evidence |
| --- | --- | --- | --- | --- |
| 1. CLI and PTY | AntigravityTerminalSession and its registered terminal factory | Read and write through the pseudoterminal, resize, close, and observe exit. Exercise signed-out and slow bootstrap paths separately. | An enabled menu can still launch the headless process. | Installed agy, live prompt, and a controlled child process for error paths. |
| 2. Conversation ownership | terminalIdentity and a per-pane ID | Drive native `/new`, ignore unrelated records and reject a missing explicit resume target. Check the actual provider acknowledgment for a requested resume. | A painted prompt can belong to a different conversation. | Agy's per-process diagnostics and the real missing-ID probe. |
| 3. App handoff | Runtime selection, view picker, restore metadata and guarded replacement | Exercise new panes, saved conversations, previous ACP panes, cancellation, failed successors and activity or identity changes during a switch. | Killing the source early can lose a running turn even if both launchers work. | Actual renderer entry points and the registry probe with overlapping successor and source lifetimes. |
| 4. Distribution boundary | Tested application build and PR | Type-check, build the main process and renderer, run the focused suites and run the opt-in live probe on the combined tree. | A local CLI probe does not verify the application wiring. | Application build and integration test results recorded on the PR. |

## Ownership and fixtures

Agy owns conversation IDs. Only the native runtime consumes its per-process diagnostic stream. The identity parser accepts active-conversation metadata, bounds partial lines, and discards unrelated bytes. No renderer or command handler reads those diagnostics or agy's SQLite contents. The registry selects the launcher. The workspace owns view preference, source revalidation and replacement. Automated workers continue to use ACP by default for their session-specific tools.

The system tests use a contract-probe child for PTY operations and bootstrap failures. The identity examples use the observed agy diagnostic format with substitute IDs. Overlong lines, missing records and interleaved unrelated IDs are deliberate mutations. The live test uses agy's own prompt and local command in a trusted directory. Keep raw logs and user conversation contents out of fixtures.

## Unknowns and discarded approaches

1. A future CLI can change its diagnostic format. Keep the positive-resume probe as the compatibility check. A process ID or another pane's files cannot establish which conversation opened.
2. Native agy loads its configured MCP servers. The known mechanism for attaching Agent Code's per-pane tools is ACP. Native mode does not write global or workspace MCP configuration.
3. A signed public build needs its own release. The development evidence applies to this branch.

The structured-only provider flag, selecting the most recent conversation in the directory, and treating a successful process spawn as a successful resume all failed the observations above.
