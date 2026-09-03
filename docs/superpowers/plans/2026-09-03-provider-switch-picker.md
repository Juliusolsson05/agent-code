Status: In progress

# Explicit provider switch picker plan

Issue: #756

## Outcome

Replace the session-level Switch Provider command's registry-order cycle with
an explicit destination picker. A Claude, Codex, or OpenCode agent should show
every destination declared by its provider capability record and perform one
transcript conversion only after the user chooses.

## Constraints

- Capture the command-target session id before opening the picker. Dispatch and
  Tiled Dispatch can change focus independently of modal state; selection must
  never switch whichever pane happens to be focused later.
- Derive destinations and labels from the provider registries. The picker must
  not recreate a three-provider matrix that drifts when support changes.
- Keep the current provider as context, not a selectable no-op destination.
- Route the selected source/target pair through the existing
  `switchAgentProvider` transaction so progress, source-empty handling, MCP
  continuity, pane replacement, and failure reporting remain unchanged.
- Store only the transient captured session id in `uiShell`. A half-finished
  picker is application chrome, not durable workspace state.
- Match existing modal keyboard and pointer behavior: Up/Down (and Ctrl-P/N),
  Enter, Escape, hover, click, and Cancel.

## Implementation

1. Add a session-scoped provider-switch picker intent and open/close actions to
   the UI shell and command context.
2. Change Switch Provider to close the command palette and open that picker for
   the resolved command target instead of starting an implicit cycle.
3. Replace `switchFocusedProvider()` with an explicit
   `switchSessionProvider(sessionId, targetKind)` workspace action that validates
   the latest source kind and declared edge before invoking the shared switch
   transaction.
4. Add a registered modal surface that lists provider-registry destinations and
   commits the captured source/target pair exactly once.
5. Add behavior-focused tests for command routing, option enumeration,
   keyboard/pointer selection, cancellation, and stale/invalid edge defense.
6. Run focused renderer tests, typecheck, and the applicable package checks;
   update this plan and the PR with exact verification results.

## Verification

- Focused Vitest coverage for command, picker, provider action, and UI-shell
  state.
- `npm run typecheck`
- `npm run check` where the local machine's fixture corpus permits it.
