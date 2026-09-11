# Claude worktree transcript continuity

Status: implemented and locally verified; coordinated PR review/CI next.

## Problem and constraints

Native EnterWorktree relocates the same Claude session's transcript. Launch cwd is a hint, not durable transcript identity. The captured prompt was saved 31 ms after Enter but acknowledgement timed out against a missing file. Preserve exact identity and durable acknowledgement; never retry written prompts or synthesize acceptance from screen/proxy activity.

## Implementation sequence

1. Add deterministic filesystem regressions for resume from a missing original path and live transcript relocation. Include return to the original directory, stale relocation markers, ambiguous duplicates, foreign session identities, copied-history deduplication, and cleanup.
2. Implement one bounded exact-session resolver in claude-code-headless. Prefer a validated cwd candidate, follow native relocation metadata, discover the exact filename across provider project directories when needed, and reject ambiguity rather than guessing by mtime.
3. Bind headless observation to the resolved session, recover path changes, and distinguish missing resumes from fresh files not created yet. Keep replay/acceptance boundaries explicit and avoid replaying copied history during relocation.
4. Consume the public resolver in Agent Code history/session operations. Add host integration coverage for actual filesystem reads and real headless-to-prompt-acceptance delivery through the public package API.
5. Run targeted red/green regressions, repository checks and package verification, review diffs, synchronize Issues and open coordinated PRs. No merge without explicit user approval.

## Validation and ownership

Package system tests own resolver/watcher behavior. App system tests own history and delivery integration, without imports into package-private modules. Fixtures contain synthetic session IDs/content in isolated temporary directories; no personal home or provider credentials. Watchers, subprocesses and temporary files are always cleaned up. Real CLI verification is a separate explicit live check and must not touch the user's active session.

## Completion record

Issue: https://github.com/Juliusolsson05/agent-code/issues/883. Package fix: https://github.com/Juliusolsson05/claude-code-headless/pull/58 (commit dc352b7). This resolves a specific relocation cause within #290, not that issue's entire disconnected-transcript scope.

- The package owns exact-session discovery and cursor-preserving relocation. Agent Code consumes its public resolver for initial/older history and rewind/provider-switch source reads, while new projected transcripts still write to their target cwd.
- Fresh assigned UUIDs explicitly allow a missing first file. Missing resumed transcripts reject startup/history loading; startup rollback disposes the constructed headless instance as well as its PTY.
- Six new app system cases exercise real filesystem reads, the real headless package, screen parsing and durable prompt delivery through public APIs. Only the OS/provider process boundary is simulated. Assertions include exactly one Enter, no copied user replay, missing-resume failure, fresh startup and rewind source resolution.
- Targeted regression cases were observed red before the fixes. Final targeted verification passes 79 tests across 11 files. Typecheck, contract, retained worktree fixtures, keybindings, live-resume-probe types, conditions-core sync and the complete application build/output verification pass.
- The broad app coverage run passed 3,185 tests and failed only the known personal-transcript dependency tracked by #641. That same test fails on untouched main; it is unchanged here. The final additional rewind-source case and affected suites pass separately. Package check/coverage passes all 132 tests.
- Local verification used Node 25.5.0; CI supplies supported-version checks. No signed release or full live native CLI/UI run was performed. The resolver was also checked read-only against the actual incident file; private captures are not committed. No merge is authorized.
