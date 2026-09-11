# TLDR agent summaries

Status: implementation in progress. Issue: #888.

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
