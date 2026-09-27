# Floating-surface layer: named layers, side-panel shell (#512)

## Where #512 stands on main (inventory, 2026-09-27)
- **Done by earlier work:** shared Radix `dialog.tsx` for modals, shared `dropdown-menu.tsx` (AppearanceMenu and the Skills menu moved onto it), one toast (CaffeinateToast forwards to `GlobalToast`), and the shared side-panel header `PanelHeader`.
- **Left:**
  1. **No named layer scale.** The bands are real but spelled as magic numbers in about ten files:
     - pane overlays z-40/50;
     - pane dialog z-[60..62];
     - dialog z-[1100];
     - menus z-[1150];
     - toast/dictation z-[1200];
     - debug highlight z-[10000].
     Comments in `registry.tsx`, `App.tsx` and `surfaces/types.ts` still describe the old "everything z-50, DOM order breaks ties" model.
  2. **No shared side-panel shell.** Git and Worktrees are identical; Agent Status is near-identical. The six debug panels copy their own shell and header, and their closes have no accessible name.
  3. **RemotePanel is registered as a side panel but renders a centered Dialog.**
  4. **No dismiss stack / `anySurfaceOpen()`.** Escape arbitration is Radix's own layer stack, plus the central `useKeybinds` branches, plus per-component handlers.
  5. **Three hand-rolled anchored popovers remain:**
     - CommandSortControl: keeps focus in the palette input;
     - PathInput suggestions: a combobox;
     - ExplorerPane context menu: pointer-anchored, with a WHY for not moving.

## This PR
- **`ui/layers.ts`:** ONE table of named layers as literal Tailwind classes (Tailwind only emits classes it sees spelled out, the rule `PANE_DIALOG_LAYERS` already follows). Every magic z value in the bands above moves onto it, and `PANE_DIALOG_LAYERS` becomes a view of it. The stale comments are corrected.
- **`components/ui/side-panel.tsx` `<SidePanel>`:** the shared outer shell (`aside`, fixed width, border, surface, column, overflow). Git, Worktrees, Agent Status and the debug panels render through it. The debug panels also move to `PanelHeader`, which gives their closes a name.
- **RemotePanel** moves from `sidePanelSurfaces` to the modal surfaces it actually is.
## Sequencing (steering q95)
W1's open #1394 edits `useKeybinds.ts` and its ownership tests, and owner keyboard work (#1221 follow-ups) is in flight. Until #1394 merges, this PR does NOT touch `useKeybinds.ts` or its tests.

## The dismiss stack moved out of this PR (review b)
A first version shipped an unwired `ui/dismissStack.ts`. Review showed its wiring contract could not work as written:
- **Capture phase is too early.** A document capture-phase Escape listener runs BEFORE the inner handlers that implement two-phase dismissal (PathInput suggestions, then the modal; palette sub-modes), so it would close the modal first.
- **Effect order is not stacking order.** Passive-effect registration order is not visual stacking order: a parent and child that mount in the same commit register child-first, so Escape would close the parent.

Both need a different arbitration design, done together with the `useKeybinds.ts` wiring on a fresh origin/main after #1394 merges. Shipping an unwired module with a known-wrong contract would mislead that work.

## Not in this PR, and why
The three remaining anchored popovers stay custom. Each has a documented reason a menu primitive does not fit:
- the palette input must keep DOM focus;
- the path field is a combobox;
- the explorer menu is anchored at the pointer.

A popover primitive shaped around one of them would be fitted to one caller. The PR therefore says `Refs #512`, not `Fixes`. #512 stays open for the dismiss stack plus its useKeybinds wiring, and for the popover decision.
