# Set Agent Title Implementation Plan

> **Status: IN PROGRESS**

**Goal:** Let the user assign, edit, and clear a durable title for the focused
agent from Grid, classic Dispatch, or Tiled Dispatch, then show that title as a
second pane-header row and as the preferred Dispatch index label.

**Architecture:** Reuse `SessionMeta.title`, which is already the workspace's
single durable agent-label field and is serialized to `workspace.json`. A
session-scoped command captures the Dispatch-aware command target and opens a
transient modal keyed by that session id. The modal commits through one
workspace action that trims the value, removes the field when cleared, and
caps user input before it reaches persisted state. `PaneHeader` reads the same
metadata for Grid and every Dispatch pane renderer. Dispatch rows retain their
latest-prompt fallback only when no explicit title exists.

## Constraints

- The command must target the visible/focused agent through
  `commandTargetSessionId`; Grid focus and Dispatch focus must not fork.
- Terminal sessions are out of scope: the feature is agent metadata, and the
  command must not appear for a plain shell pane.
- No second persistence path. `SessionMeta.title` remains the source of truth,
  and existing workspace autosave/rehydration owns durability.
- Empty or whitespace-only input clears the title and restores the existing
  untitled presentation.
- The title row is conditional. Untitled panes must not permanently lose feed
  height to an empty header.
- Existing orchestration-provided titles remain compatible and editable.
- Add thick WHY comments at the command-target, persistence-normalization, and
  Dispatch-fallback boundaries.

## Tasks

- [ ] Add title normalization and an identity-stable workspace mutation for
  setting/clearing one agent title.
- [ ] Add transient UI-shell state, a `Set Agent Title…` session command, and an
  app-root modal that edits the captured target without focus-race drift.
- [ ] Render an explicit title directly below the pane's status/path/index row
  in Grid, classic Dispatch, and every Tiled Dispatch lane.
- [ ] Make explicit titles win over latest-prompt-derived Dispatch row text,
  while preserving the prompt fallback for untitled agents.
- [ ] Add focused tests for normalization/state mutation, Grid and Tiled
  Dispatch target capture, modal save/clear behavior, pane-header rendering,
  Dispatch precedence, and persisted-title recovery.
- [ ] Run renderer tests, command/catalog checks, typecheck, and the broader
  project checks justified by the final diff.
- [ ] Review the final diff, update this status, open an unmerged PR, and report
  verification and remaining limitations.

