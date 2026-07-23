# Dispatch color flags — plan

Date: 2026-07-23
Branch: `feat/dispatch-color-flags`

## The ask

Running 4+ agent workflows in Dispatch, the user loses track of rows. Add a
**"Set color flag"** command that opens a swatch modal and paints a thick
**10px colored strip on the right edge** of that agent's Dispatch row, so a
flagged agent (e.g. red) is instantly spottable while scanning the list.

```
 SESSIONS ──────────────────────────── agent-code
 ┌────┬────────────────────────────────────┬──┐
 │ A2 │ yes that is reasonable...          │██│ ◄ red flag (10px, full row height)
 │    │ idle · main · Claude               │██│
 ├────┼────────────────────────────────────┼──┤
 │ A3 │ Buffer 2 — migration research      │  │   no flag
 │    │ feat/extension-platform · Claude   │  │
 ├────┼────────────────────────────────────┼──┤
 │ A8 │ SUre go about and do the...        │▓▓│ ◄ blue flag
 │    │ awaiting · feat/extension-plat...  │▓▓│
 └────┴────────────────────────────────────┴──┘
```

Confirmed decisions:
- **Target** = the currently-commanded agent (`commandTargetSessionId`), so the
  command needs no extra row-selection step.
- **Persistence** = per-session, survives restart. Stored in `Settings`
  (the zustand-persisted store), keyed by `sessionId`.
- **Palette** = fixed 6 swatches + "none" (red / orange / yellow / green /
  blue / purple). No full RGB picker, no custom hex (can add later).
- **No keybind.** Command-palette entry only.

## Why these seams (mirrors existing patterns exactly)

Everything here has a direct precedent, so the feature slots into known
machinery rather than inventing any:

- **Session-scoped modal** ← `AgentViewModePicker`: a uiShell slice field
  (`agentViewModePickerSessionId` + open/close), a Surface
  (`AgentViewModePickerSurface`, registered in `app/surfaces/registry.tsx`),
  and a `ctx.ui.openAgentViewModePicker(sessionId)` the command calls.
- **Command targeting the active agent** ← `sessionCommands.ts`, which reads
  `commandTargetSessionId(ctx.workspace)` (Dispatch-aware focus) and calls a
  `ctx.ui.open*` opener.
- **Persisted per-key preference** ← `Settings` + `coerceSettings` + the
  store's `partialize: { settings }` and version bump.

## The pieces

### 1. Palette + settings (persistence)
- New `dispatchColorFlags.ts` (settings-adjacent): the palette — an ordered
  list of `{ id, label, swatch, strip }` (id like `'red'`; `swatch`/`strip` are
  theme-token CSS values so light/dark both read well), plus `COLOR_FLAG_IDS`
  and an `isColorFlagId` guard.
- `Settings.dispatchColorFlags: Partial<Record<string, ColorFlagId>>` (sessionId
  → color id). Default `{}`. Coerced in `coerceSettings` (drop non-object,
  drop values failing `isColorFlagId`). Bump `PERSIST_VERSION`.
- Slice setter `setDispatchColorFlag(sessionId, id | null)` — sets, or deletes
  the key when `null` (clear). Lives on the settings slice next to the other
  `set*` settings actions.

### 2. uiShell modal state
- `colorFlagPickerSessionId: SessionId | null` + `openColorFlagPicker(sessionId)`
  / `closeColorFlagPicker()` on the uiShell slice.

### 3. Command
- `dispatchColorFlagCommands` → command `dispatch.color-flag.set`, title
  "Set color flag", keywords `[color, flag, highlight, mark, tag, dispatch]`.
  `when`: `commandTargetSessionId(ctx.workspace) !== null`. `run`: open the
  picker for that session. Registered in `registry.ts`.

### 4. ui wiring
- Add `openColorFlagPicker(sessionId: string)` to `CommandContext.ui`, wired
  where the `ui` object is assembled (same place `openAgentViewModePicker` is)
  to `openColorFlagPicker` from the store.

### 5. Modal + surface
- `ColorFlagPickerModal` — swatch grid (each swatch a button; current one
  ringed), a "Clear flag" button, "Done". Picking a swatch calls
  `setDispatchColorFlag(sessionId, id)` and closes; Clear passes `null`.
  Shows the agent's pane label / title in the header for context.
- `ColorFlagPickerSurface` reads `colorFlagPickerSessionId` and renders the
  modal `open={sessionId !== null}`; registered in `app/surfaces/registry.tsx`.

### 6. The row strip
- In `DispatchAgentRow` (`DispatchAgentList.tsx`, the `<button>` — already
  `relative` + `overflow-hidden`): read
  `settings.dispatchColorFlags[row.sessionId]`; when set, render an
  absolutely-positioned right-edge strip
  (`absolute right-0 top-0 bottom-0 w-[10px]`) with the strip color. Absolute
  overlay rather than a real `border-r-[10px]` so it never steals content
  width or disturbs the existing layout, and it sits above the row's own
  right padding (`pr-2.5`).

## Scope / not now
- Only the primary `DispatchAgentList` row gets the strip in this PR (that IS
  "the list" the user scans). The `DispatchMiniList` and tiled lanes can get it
  in a follow-up if wanted — noted, not built.
- No custom hex, no per-row context-menu entry, no keybind.

## Verification
1. `tsc --noEmit` on both projects (node → `tsc -b` → web).
2. Existing suite (`NODE_ENV=test npx vitest run`).
3. Manual: run "Set color flag" on a Dispatch agent → pick red → the row shows
   a red right-edge strip; "Clear flag" removes it; the flag survives an app
   restart (persisted in settings).
