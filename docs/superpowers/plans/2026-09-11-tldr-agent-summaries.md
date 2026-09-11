# TLDR agent summaries

Status: implemented. Issue: #888. PR #892 carries the final validation status.

## Outcome

An optional TLDR MCP lets each agent replace its own concise status after
substantial work or discussion. Hold Cmd+L to reveal saved summaries centered
in darkened visible agent panes. Release either key or leave the window to
dismiss. The editor retains Cmd+L Select Line. A palette command provides a
toggle/Escape route to the same view. Reading summaries never calls a model.

## Implementation

1. Add the disabled-by-default `tldr` MCP domain, scoped update tool, shared
   bounded text contract, and main-owned persistence with renderer observation.
   Preserve summaries through logical-session replacement; fresh sessions and
   duplicates start without a summary. Invalidate stale summaries on rewind or
   unrelated resume rather than carrying claims from discarded history.
2. Extend the existing managed-skills single writer with the reserved
   `agent-code-tldr` instruction-only skill. Materialize through existing
   collision/ownership rules before an enabled agent starts. Keep personal
   conventions untouched, and make activation conditional on TLDR availability.
3. Add the per-agent TLDR MCP command, new-agent default setting, and preview
   command. Reuse process replacement/resume for MCP capability changes.
4. Mount a pane-local overlay around the displayed agent in WorkspaceLeaf so
   Grid, Dispatch, Spotlight, related-agent selections and terminal views share
   one implementation. Keep preview state transient and existing views mounted.
5. Add explicit hold handling through the effective keybinding table; release
   and blur cleanup must remain live even when a modal takes input. Ignore
   repeats, preserve editor input ownership, and stop shortcut text leakage.
   A macOS Electron probe confirmed that AppKit drops Cmd-letter keyUp before
   either main or renderer receives it. Add a release-only mode to the existing
   packaged native helper: query just the accepted hold's physical key while
   held, without an event tap or Accessibility prompt, and cancel on blur or
   renderer navigation. This does not share dictation's global shortcut owner.

## Validation

- MCP capability absence when disabled, authenticated self-only writes, text
  limits and replacement semantics.
- Durable summary restoration, session replacement, stale-write isolation,
  duplicate/rewind behavior, and renderer subscription races.
- Managed skill creation, reserved-name collisions, repeated reconciliation,
  and inactive behavior without this session's MCP capability.
- Hold/release/repeat/blur, editor ownership, palette toggle/Escape, and correct
  per-pane identity in rendered and terminal views without unmounting content.
- Run focused tests, then `npm run check`, review the diff, push the completed
  branch and open a PR linking #888. Follow CI and address valid feedback.
  Do not merge without explicit user authorization.

## Constraints

Keep reasoning in WHY comments near the implementation. Do not write provider
skill files from renderer/provider code or bypass the managed-skills authority.
MCP tool identity comes from authentication, never a model-supplied target ID.
Summaries describe verified outcomes and pending decisions in one or two short
sentences; minor unchanged clarifications do not require an update. Use a hard
character bound rather than unreliable punctuation-based sentence counting.

## Validation evidence

Focused suites exercise actual MCP SDK clients over both in-memory and loopback
HTTP transports, temporary-file persistence, revoked in-flight writers, managed
skill restart/collision behavior, the real session action hooks and workspace
leaf selection, and renderer hold/subscription races. Generated skill validation
and the universal native-helper build pass. An offscreen Electron fixture checks
pane geometry and the actual overlay CSS without opening another visible window.

Four deliberately broken safeguards each fail their corresponding tests:
removing native release observation, selecting the physical parent's summary,
dropping reload/provider-translation identity carry, and permitting an in-flight
revoked caller to write over its successor. Mutation files were restored before
running the full repository gate. Provider-model compliance with the reporting
instructions remains a live-use check, not something these deterministic tests
claim to prove.

The full local suite ran 3,222 tests: 3,220 passed; the missing TLDR feature
reference was added and its targeted test passes. The remaining image-fixture
provenance failure reproduces on the unchanged base revision `07fec7ec`: a
cited private Claude recording no longer exists on this machine. No fixture,
expectation, private recording, or skip rule was changed to mask that failure.
