Status: Complete

# Explicit provider switch picker plan

Issue: #756

## Outcome

Replace the session-level Switch Provider command's registry-order cycle with
an explicit destination picker. A Claude, Codex, or OpenCode agent should show
every destination declared by its provider capability record—including both
structured OpenCode and OpenCode Terminal launch choices—and perform one
transcript conversion only after the user chooses.

## Constraints

- Capture the command-target session id before opening the picker. Dispatch and
  Tiled Dispatch can change focus independently of modal state; selection must
  never switch whichever pane happens to be focused later.
- Derive destinations and labels from the provider registries. The picker must
  not recreate a three-provider matrix that drifts when support changes.
- Share OpenCode's structured/terminal choice expansion with the new-agent
  picker. Both rows use the same provider transcript adapter; only the
  replacement spawn receives terminal runtime metadata.
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
   `switchSessionProvider(sessionId, targetKind, targetProviderRuntime)` workspace
   action that validates the latest source kind and declared edge before
   invoking the shared switch transaction.
4. Extract the new-agent provider/runtime choices into a shared renderer source,
   then add a registered modal surface that filters those choices through the
   source provider's declared edges and commits the captured destination once.
5. Add behavior-focused tests for command routing, option enumeration,
   keyboard/pointer selection, cancellation, and stale/invalid edge defense.
6. Run focused renderer tests, typecheck, and the applicable package checks;
   update this plan and the PR with exact verification results.

## Verification

- Focused picker, command, provider-switch, and new-agent Vitest coverage:
  5 files / 32 tests green.
- UI-shell store coverage: 1 file / 8 tests green.
- `npm run check` passed test contracts, checked-in worktree fixtures,
  keybindings, TypeScript, and the transcript parser's live-resume probe.
- The aggregate Vitest run passed 350 files / 2,508 tests and reported two
  unrelated local failures: a known personal transcript fixture points at a
  removed `~/.claude` session, and the capped-text-buffer fuzz case exceeded
  its five-second budget under host contention.
- The fuzz suite passes 1 file / 10 tests when rerun with a 15-second timeout;
  its invariant case completed in 9.89 seconds.
- `npm run test:package` — green; the production build contains every required
  entry point.
