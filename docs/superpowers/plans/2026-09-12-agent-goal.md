# Agent Goal

Issue: #936

## Problem

A TLDR is status: "#933 passed CI; renderer gap-up passes 58 tests; #920 review
remains." Accurate, but it never says what the agent is for. The first-prompt
TLDR nudge (#917) asks agents to write their goal into the TLDR, where the next
status update overwrites it.

## Decisions made with the user

- 1A: Goal is its own MCP domain with its own setting and session command,
  independent of TLDR.
- 2A: agent-written only in this version (`goal_set`); no user editing.
- 3A: Cmd+G shows the goal; Cmd+L stays TLDR-only.

## Design

### Data and identity
- A second `TldrStore` instance (`goal.json`, `goal-history/`, label "Goal")
  gives goals the store's existing guarantees: serialized atomic writes,
  revocation re-checked after I/O, bounded per-identity history.
- The conversation identity (`SessionMeta.tldrIdentity`, name kept to avoid
  a persisted-field migration) is minted when TLDR or Goal is enabled. Reload,
  provider switch, duplicate, rewind and Undo Rewind semantics carry over
  unchanged for both.

### MCP
- `goal` joins the built-in domains for Claude, Codex and OpenCode, and the
  configurable defaults (off by default).
- `goal_set` writes only the caller's goal through the authenticated scope,
  fails closed on revocation, and exists only with the domain. Goal instructions
  travel in MCP initialization, like TLDR's.

### Managed skill
- `ensureTldrSkill` becomes a shared product-skill routine used by both
  `ensureTldrSkill` and `ensureGoalSkill`: same journal, collision checks,
  reserved names, `managedBy`, and mutation refusals.
- A Goal-enabled launch fails when its skill cannot deploy, as TLDR does.

### Enforcement (reuses #917 hooks)
- Hooks are injected when TLDR or Goal is enabled. The host passes each
  registration's enabled features to the policy.
- Prompt with Goal enabled and no goal: ask for `goal_set`. The TLDR goal
  nudge is only used when Goal is off.
- Stop: the missing goal and the TLDR rules are combined into one reason and
  block at most once per turn. Subagent and steer isolation are unchanged.
- The TLDR skill's wording stops telling agents to put the goal into the TLDR
  when Goal is available.

### Renderer
- View state gains `preview: 'tldr' | 'goal'`. The hold controller, native
  release watcher, Escape and input gating are shared.
- `goal-preview` (Cmd+G, global) routes through the synchronous hold handler.
  The editor keeps Monaco's Find Next through a reservation and an approved
  overlap.
- One overlay component is parameterized by kind; each pane mounts a TLDR and
  a Goal overlay. The Goal footer says "Goal set".
- `enable-goal-mcp` session command and "Goal MCP" Settings row.
- View TLDR History merges goal changes as labeled rows.

## Verification plan

Real MCP host and bearer scopes for `goal_set` and Goal-only enforcement;
policy tests for combined rules; managed-skill system tests; keyboard router
tests for Cmd+G hold/release, editor yield and rebinding; overlay and history
renderer tests; domain/settings/catalog governance; deliberate-regression
checks; full `npm run check` and CI.

## Constraints

Never launch the Agent Code app. Keep WHY comments inline. Do not merge
without authorization.
