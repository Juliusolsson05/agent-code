# Claude worktree transcript continuity

Status: implementation planned.

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

Update with final design decisions, checks, limitations, linked Issues and PRs before delivery.
