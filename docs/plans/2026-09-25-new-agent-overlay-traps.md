# New Agent overlay input traps (#1269, #1270)

Found by the Stage 3 C4 hunt (`temp/quality-loop/hunt-c4.md`); verified against origin/main.

## #1269: hidden overlay owns input
- The overlay's capture-phase keydown listener runs whenever `open` is true. Its root div carries the app interaction-owner marker, and `hasAppInteractionOwner` is a plain `querySelector`, so display:none does not hide the marker from it.
- It is mounted inside RetainedWorkspaceSurface (display:none under Reader/Spotlight/Settings) and inside GlobalEditorWorkspaceSlot (display:none under a fullscreen editor).
- The palette is not focus-filtered: FOCUS_MODE_COMMAND_IDS gates keybinds only. So "New Agent…" can open the overlay invisibly. Arrows are swallowed, Escape no longer leaves Spotlight, and Enter creates an agent.
- Fix: while its surface is hidden, the overlay renders nothing and registers no listener. `open` is kept, so it appears when the surface returns: the user asked for it, and nothing acts until they can see it. GlobalEditorWorkspaceSlot also provides WorkspaceSurfaceHiddenContext (OR'ed with the outer value). Its only other consumer, GlobalEditorShell, reads the context from outside the slot, so nothing else changes.

## #1270: dead overlay after a failed create, raw spawn toast
- `createDetachedDispatchAgent` returns null on three failures and never closes the overlay. `committingRef` resets only when `open` changes, so Enter is dead while the marker keeps every shortcut blocked.
- Fix: when the create settles without a session, reset the latch so the user can retry or press Escape. The same applies to the linked path.
- The spawn-threw toast showed `err.message` verbatim, which steering q22 forbids. It now uses `SESSION_START_FAILED_MESSAGE`.

## Tests
Renderer tests against the real overlay:
1. The overlay is open inside a hidden surface: Enter does not create an agent, and no owner marker is present.
2. A create that resolves null: a second Enter creates again.
3. The pane.ts spawn failure toast does not contain the raw text.
Each must fail on main first.
