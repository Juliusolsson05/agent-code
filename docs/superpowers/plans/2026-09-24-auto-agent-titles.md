# Agent titles: let opted-in agents maintain a short current-job label

Fixes #1210. Branch `feat/auto-agent-titles` · Worktree `.worktrees/auto-agent-titles` · Base `origin/main` @ `6d9ec6a7` (2026-09-24)
Status: approved for full build by the user's “implement all of this” instruction.
Decomposition: `docs/decomposition/auto-agent-titles.md` — its stages govern execution.

## Outcome

Users can enable Auto Title for agents. An agent can maintain a short label naming its current job, independently of Goal and TLDR. A person's title or explicit clearing wins. The title stays consistent in the live workspace and conversation picker.

## Evidence (verified, do not re-derive)

- `src/renderer/src/workspace/agentTitle.ts` is the durable title reducer; `SessionMeta.title` is the app's one visible title field. It currently has no provenance.
- `src/main/conversations/catalog/label.ts` prefers the ledger's Agent Code title over native names/titles.
- `src/mcp/runtime/BuiltInMcpHttpHost.ts` mints and revokes per-process bearer registrations; `createBuiltInMcpServer.ts` demonstrates self-scoped Goal/TLDR writes.
- `src/providers/shared/runtime/tldrHooks.ts` injects launch-only Claude/Codex hooks; `src/main/tldr/enforcement.ts` gives at most one turn-end block.
- `docs/decomposition/conversations.md` records 310 generated titles in 371 Claude transcripts and 2,007 Codex index rows; these are not a uniform live-title source.
- `docs/decomposition/auto-agent-titles.md` has Stage 0 verdicts and the provider-specific unknowns.

## Decisions

1. Opt-in, off by default; reuse the per-provider/per-agent built-in MCP preference and next-reload contract. User accepted 2026-09-24.
2. A title describes the substantive job in roughly 3–7 words. The agent updates it on a new job or direction change, not each response. User accepted 2026-09-24.
3. Manual set and manual clear pause auto writes; an explicit resume action restores automatic control. Existing titles are treated as manual. User accepted 2026-09-24.
4. Native titles remain catalog fallbacks; the agent-authored title uses Agent Code's workspace owner. User accepted 2026-09-24.
5. Hooks nudge a missing title only where verified. A skill/tool remains available on all five MCP routes. User accepted 2026-09-24; precise Grok/OpenCode/Pi hook delivery remains evidence-dependent.

## Design

Add `auto_title` to the configurable built-in MCP domains, absent from shipped defaults. Keep the active-domain snapshot as the authority for a running agent. Add title provenance/pause metadata to `SessionMeta`; absence on a legacy titled pane means manual. The manual reducer sets a protected title or paused clear. The agent reducer accepts only an active agent session with Auto Title enabled and no manual lock; a resume action releases the lock.

`title_set({title})` takes no session ID. The bearer scope supplies it. The main MCP handler invokes an application-only exact-session control capability; renderer checks current metadata and applies the pure reducer. The main host checks revocation around the request. No native transcript is modified.

Managed skill guidance says to set a short title on understanding a substantive task and update only on a change of job. Extend the existing Claude/Codex turn-hook pipeline for a missing-title nudge without adding an independent Stop loop. Probe Grok's current hook route and the OpenCode/Pi event/extension paths before asserting equivalent enforcement. Keep unverified providers guidance-only with their MCP tool, and report that limit.

## Files

- Modify MCP domain/settings registry and managed-skill tables — opt-in delivery.
- Modify workspace title reducer, metadata, replacement, and title UI/control — precedence and resume.
- Modify MCP host/server, main composition, renderer control capability — authenticated exact-session bridge.
- Modify hook policy and provider adapters where recorded support exists — missing-title nudge.
- Update README and relevant user-facing setting text — explain cadence, override, and reload.

## Tests

- Workspace title tests from existing real reducer/replacement cases: legacy title, manual clear, auto change, terminal exclusion, resume; fail before implementation.
- MCP host/client tests from existing bearer/revocation fixtures: self scope, denied/stale bearer, no target-session parameter; fail before implementation.
- Control routing tests from existing two-window owner fixture: exact owner and manual precedence; fail before implementation.
- Hook tests from recorded Claude/Codex vectors: missing-title reminder and combined one-block behavior; fail before implementation.
- Setting/skill tests from current persistence and managed materialization fixtures: off-by-default and launch-on-reload.

## Verification

Run focused tests for each stage, then typecheck, lint, build and the project's full test/check command once. Review the diff and one independent PR review round; resolve valid findings. Open a built PR and wait for explicit merge approval. Native packaged behavior beyond what can be probed on this machine is a reported verification boundary.

## Out of scope

- Replacing provider-native titles or writing into their session stores: would create conflicting ownership.
- A separate title-generating model call after every turn: cost and title churn conflict with the requested semantics.
- Automatically titling plain terminals: they have no agent to decide a job label.

## Tasks

- [ ] Stage 1: land provenance, reducers, setting, and managed skill; hand title state and `auto_title` domain to Stage 2.
- [ ] Stage 2: land authenticated title tool and exact-session renderer bridge; hand current-title observation to Stage 3.
- [ ] Stage 3: land provider guidance/hooks, resume UI, and user docs; verify provider-specific limits.
- [ ] Finish: full checks, plan-versus-built audit, one PR review, and open PR without merging.

## Execution notes

- 2026-09-24: Stage 0 source/corpus census recorded in decomposition. Fresh worktree from `origin/main`; unrelated root-worktree changes remain untouched.
