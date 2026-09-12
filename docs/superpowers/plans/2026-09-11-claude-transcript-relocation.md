# Claude worktree transcript continuity

Status: review findings resolved and re-reviewed; final CI pending. User authorized merging after verification.

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

Issue: https://github.com/Juliusolsson05/agent-code/issues/883. Package fix: https://github.com/Juliusolsson05/claude-code-headless/pull/58 (merged commit dd89f3836d14f1bbc028dcf1523a544f1b9ae930). This resolves a specific relocation cause within #290, not that issue's entire disconnected-transcript scope.

- The package owns exact-session discovery and cursor-preserving relocation. Agent Code consumes its public resolver for initial/older history and rewind/provider-switch source reads, while new projected transcripts still write to their target cwd.
- Fresh assigned UUIDs explicitly allow a missing first file. Missing resumed transcripts reject startup/history loading; startup rollback disposes the constructed headless instance as well as its PTY.
- Eight new app system cases exercise real filesystem reads, the real headless package, screen parsing and durable prompt delivery through public APIs. Only the OS/provider process boundary is simulated. Assertions include exactly one Enter, no copied user replay, missing-resume failure, fresh startup, rewind source resolution, legacy fork resume and mixed available/missing batch lookup.
- Targeted regression cases were observed red before the fixes. Review-fix verification passes 96 tests across 12 files, including the history loader suite. Typecheck, contract, retained worktree fixtures, keybindings, live-resume-probe types and conditions-core sync pass. Final CI verifies the complete application test/coverage/build gate.
- Before review fixes, the broad local app coverage run passed 3,185 tests and failed only the known personal-transcript dependency tracked by #641, reproduced on untouched main. The complete pre-review CI suite passed 3,187 tests. Final package check now passes 138 tests and coverage passes; final app CI follows the merged package pin.
- Local verification used Node 25.5.0; CI supplies supported-version checks. No signed release or full live native CLI/UI run was performed. The resolver was also checked read-only against the actual incident file; private captures are not committed.

## Review resolution

1. Find the newest relocation record by scanning backward through the transcript; omitted middle bytes cannot hide a newer move.
2. Verify the opened file and cursor before consuming a replacement, including redirect stubs larger than the consumed prefix.
3. Preserve legacy fork ancestry using current conversation identity for discovery and separate historical replay from live identity enforcement.
4. Return unavailable entries from bulk transcript lookup; keep missing resumed history/startup failures explicit at their strict caller boundaries.

Add regressions for every finding, rerun both repositories' gates, obtain follow-up agent review, then merge the package and pin its merged commit before merging the app. The user's latest instruction explicitly authorizes both merges.

All four findings and the follow-up generic-tail atomic-replacement regression are resolved. Both reviewers cleared their scopes after rerunning the independent reproductions. The package's tests also cover a current UTF-8 identity record spanning multiple I/O chunks and inherited relocation metadata from a fork's source session.

Package PR #58 passed every CI check and merged. Its merge tree is identical to the reviewed and tested package head; the app pins that merged commit. The final local application build/output verification passed before this metadata-only pin update. Final app CI is the remaining gate before the user-authorized app merge.
