# Safe tmux workspace recovery

Status: implementation in progress. First implementation-loop slice of B00/B01 in [program #918](https://github.com/Juliusolsson05/agent-code/issues/918), following [plan PR #931](https://github.com/Juliusolsson05/agent-code/pull/931). Resolves [#898](https://github.com/Juliusolsson05/agent-code/issues/898) when implemented and verified.

Baseline: `552914f5610518458f944fa1bdaf63f243685bd1`. Source still reads the legacy workspace envelope before tmux reconciliation; current persistence uses v2 windows. No other open tmux PR was found at intake. The original checkout's untracked plan and other worktrees remain outside this change.

## Intended contract

Startup and ordinary restoration use the same workspace decoder. The decoder reports whether it discarded any potentially relevant envelope/window data. Resource inventory separately validates the terminal-reference shapes it consumes and distinguishes complete inventory (including genuinely empty) from incomplete or unknown inventory.

Only a complete inventory permits existing managed-orphan cleanup. Incomplete data may recover explicitly known live terminals and report missing references, but unmatched live sessions remain preserved. A missing/unreadable/future/corrupt workspace does not establish that a previously managed process is an orphan. Window geometry repair alone need not imply missing terminal ownership. Exact reference collection spans all retained windows and avoids duplicating equivalent tmux references.

This is a narrow resource inventory projection, not a second implementation of renderer pane ownership or the future main catalog. Ordinary workspace restoration behavior remains compatible; completeness metadata prevents its partial recovery from accidentally authorizing destruction.

## Ordered work

1. Initialize all seven package pins and an isolated dependency install; run focused existing workspace tests before changes.
2. Add composed fixture tests that call the startup inventory/decoder path and real reconciliation with a fake registry. Protect v2 multi-window and legacy recovery, complete empty inventory, malformed/future/read failures, discarded or duplicate window records, malformed session metadata, and unrelated managed/nonmanaged names under the registry contract.
3. Extend canonical decode results with explicit completeness evidence, implement bounded reason/count reporting for terminal inventory, and require that evidence at reconciliation admission.
4. Replace main startup's ad hoc JSON envelope read with the canonical inventory path; record preserved unmatched counts and completeness in diagnostics without terminal content.
5. Review source/store callers for compatibility, update the architecture's directly affected known limitation, and run focused tests, type checking, test-contract and build/package checks appropriate to the change. No real user tmux sessions are killed as a test.
6. Commit the implementation, open a complete Conventional Commit PR linked to #898/#918, inspect CI and resolve valid review findings. Do not merge without user authorization.

## Acceptance and rollback

Tests must fail against the old integration and prove that recognized v2 references survive; checking a decoder alone cannot prove cleanup safety. Only explicitly complete inventory can classify unmatched managed sessions as destructible. Invalid windows or session regions must never become an empty authoritative set. Existing restoration and independent-window persistence tests remain green.

No persistent format bump is required for additive decode evidence. Rollback can disable orphan cleanup, but cannot reinstate unknown-as-empty behavior. Preserve useful diagnostics and mark unexercised native/process behavior explicitly. Lasting WHY comments explain why partial UI restoration is weaker than destructive resource inventory.
