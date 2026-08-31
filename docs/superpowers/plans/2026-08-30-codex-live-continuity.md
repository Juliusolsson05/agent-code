# Codex live transcript continuity repair

Refs #339, #545, #716, #717, #718.

## Outcome

A current Codex CLI may decline the narrowly attested prompt-input profile
without losing its committed transcript, resume identity, or user-prompt render
handoff. A freshly built app must compile the exact package revisions pinned by
the parent repository, and the resume picker must render every matching rollout
returned for the focused Codex cwd.

## Incident contract

The 2026-08-30 live incident joined four symptoms into one causal chain:

1. Codex 0.151 correctly declined the 0.149.1-only prompt-input profile.
2. Agent Code published that optional capability refusal as `jsonl-error`, so
   the renderer announced that the transcript was unavailable.
3. The app had been built with a stale codex-headless working tree, omitting the
   exact proxy-identity rollout attachment already pinned by the parent gitlink.
   No `session_meta` reached Agent Code, so `providerSessionId` remained null.
4. Queued user prompts could not hand off to committed rows, and the next clean
   restart recovered the local pane with `hasResumeId=false`, spawning a new
   provider conversation. The independent resume picker then displayed no rows
   despite matching rollouts on disk.

No individual seam test is sufficient. Verification must preserve this joined
contract: valid rollout attachment produces durable identity, durable identity
survives restart, and committed prompt evidence retires the temporary queue row.

## Implementation

1. Separate prompt-evidence degradation from fatal transcript errors at the
   provider/main/renderer boundary. Keep the refusal observable in content-safe
   lifecycle diagnostics without mutating transcript availability.
2. Add a recorded/latest-Codex regression proving exact proxy identity can attach
   a rollout while prompt evidence is disabled, forward `session_meta`, and let
   workspace persistence retain the provider session id for recovery.
3. Exercise the renderer ownership handoff with that attached committed user row
   so the temporary queue surface disappears and the feed owns the prompt.
4. Reproduce the command-palette resume flow with modern large bootstrap records.
   Reset command-search state on mode entry and render distinct loading, empty,
   provider/cwd, and failure states.
5. Add a deterministic submodule-gitlink verifier to production build and preview
   entry points. Fail before compilation with expected/actual revisions and the
   exact safe synchronization command; do not mutate user repositories.

## Verification

- Focused Codex runtime, session lifecycle, persistence/recovery, queue handoff,
  and command-palette renderer regressions.
- Submodule verifier unit tests for exact, mismatched, and missing worktrees.
- Node and web TypeScript checks.
- Production build from a clean synchronized worktree.
- Final diff review for issue/PR synchronization, thick WHY comments, and no
  unrelated changes.

## Delivery

Open one parent PR with `Fixes #716`, `Fixes #717`, `Fixes #718`, and references
to #339/#545 unless the final behavior fully closes either older umbrella issue.
Do not merge without explicit user approval.
