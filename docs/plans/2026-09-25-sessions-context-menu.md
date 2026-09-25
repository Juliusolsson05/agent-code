# Right-click menu for the Sessions list

Status: user-approved 2026-09-25 (native menu, Sessions list only, D4 actions) · Branch:
`feat/sessions-context-menu` · Issue: #1180

## Outcome

Right-clicking an agent in the **Sessions** list (the Dispatch index) opens a
menu of that agent's actions: rename, colour flag, pin, reload, switch
provider, MCP servers, duplicate, rewind, copy resume command, close, and so
on. The actions apply to **the row that was clicked**, whichever agent is
focused, and **nothing moves**: the agent is not pulled into a lane first.

Today every one of these actions exists only as a command-palette command,
and every one of them acts on the **focused** agent. To act on an agent in the
list you must first click it, which places it in a lane and replaces what that
lane was showing, then open the palette and search. This plan removes that
detour.

## What exists today (read 2026-09-25)

### The Sessions list

- `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`.
  - `DispatchAgentList` renders the header, a Pinned section, one section per
    project, and `ChildCollapseRow` for capped orchestration children.
  - Every row is `DispatchAgentListRow` (:443), a single `<button>` with
    `data-dispatch-row`. Its `onClick` calls `focusSessionInTab(tabId,
    sessionId)`, which the tiled layout remaps to "show this agent in the
    target lane" (`TiledDispatchLayout.tsx:302-312`).
  - The row has no hover actions, no double-click, no drag and drop, and no
    `onContextMenu`.
- Every grid row mounts its own `DispatchAgentList`
  (`TiledDispatchLayout.tsx:324`), so adding the menu to the row component
  covers every row of the grid. Pinned rows and project rows share the same
  component.
- Rows can be `disabled` (the agent is already shown in another lane of the
  same grid row). Disabled blocks selection only; the menu should still work.
- The lane chip strip (`DispatchMiniList.tsx`) is a second, compact index of
  the same rows.

### Menus in the app

- **No shared menu component, and no menu library.** `components/ui` has only
  button, dialog, dialog-actions, input, label, number-input and textarea;
  package.json has no Radix menu packages.
- **The one React right-click menu** is the file Explorer
  (`features/editor/ui/ExplorerPane.tsx:624,727,758-834,997`). It is
  hand-built: `role="menu"`, arrow keys, Escape, outside-click dismissal, the
  ContextMenu key and Shift+F10, and its own `MenuItem`. It has no
  shortcuts and no submenus.
- **The native menu precedent** is the browser pocket
  (`src/main/browserPocket/nativeMenus.ts:36-59`, IPC
  `browser-pocket:menu`, preload `showPocketMenu`). The renderer sends its
  state, main builds a template with submenus, radio items and separators,
  pops it with `menu.popup({window, callback})`, and resolves with the chosen
  action, or null. The renderer applies the action and drops it if the pocket
  changed while the menu was open (`PocketMenu.tsx:24-58`).
- **No default right-click menu anywhere else**, text fields included.
  `lib/mouseArbiter.ts:246,316` blocks `contextmenu` while a mouse-chord
  anchor is held, and its comment states the app has no native context menus
  of its own.

### Per-agent actions

- About 35 palette commands act on one agent. **All of them pick the agent
  with `commandTargetSessionId(workspace)`**, in `when` and again in `run`
  (`workspace/hook/selectors/commandTargetSessionId.ts:23-70`): an open Reader
  or Spotlight takeover wins, otherwise the focused lane's occupant, and
  never a fallback.
- **No command can be run for a given session.** `CommandDef.run(ctx)`
  receives only `{ workspace, ui, flags }` (`command-palette/types.ts`).
  `dispatchCommand` has no session field. The control route's
  `expectedSessionId` (`command-palette/control.ts:46-68`) is a guard that
  rejects the call if focus moved, not a target.
- **The layer underneath already takes explicit ids.** Examples:
  - `closeSession(id, opts)`, `reloadSessionAgent(id)`,
    `switchSessionProvider(id, …)`, `undoSessionRewind(id)`,
    `softReloadAgentView(id?)`, `pinSession` / `unpinSession`,
    `toggleTailMode(id)`, `clearDraft(id)`, `setSpotlightSession(id)`
    (`workspace/hook/index.ts:1028-1089`);
  - every `ui.open…(sessionId)` modal opener (Set Title, Colour Flag, Switch
    Provider, Agent MCP Servers, Rewind, View Prompts, TLDR History, Agent
    View Mode, Linked Agent, Root Management).

  The `*Focused*` wrappers (`reloadFocusedAgent`, `closeFocused`,
  `undoLastRewind`, `removeFocusedCyberPolicyBlock`, …) just resolve focus
  and call those.
- **Close safety** runs in `closeSession`, the single path for every close
  (`workspace/hook/actions/pane.ts:1602-1690`). An idle agent closes with
  Undo; a live agent or a linked cascade asks for confirmation; the gate
  re-checks the target set after the dialog.
- **Colour flags** are a per-session setting
  (`settings.dispatchColorFlags[sessionId]`, `DISPATCH_COLOR_FLAGS`).
- **Shortcut display**: `displayKeybinding` (`src/shared/keybindings.ts:279`)
  gives `⌘⇧P`; the palette shows the effective binding per command
  (`command-palette/registry.ts:208,218`).

## Decisions

### D1. The menu is built from the command catalog, not a second list of actions

Commands opt in with metadata:

```ts
contextMenu?: { group: 'open' | 'identity' | 'agent' | 'copy' | 'close'; order: number }
```

The menu shows every opted-in command whose `when` is true **for the clicked
row**, grouped and ordered, with its title and its effective shortcut from the
same registry the palette uses.

WHY: it gives one source of truth.
- **Hidden entries stay hidden.** A command hidden, disabled or re-titled in
  the palette (visibility settings, `when`) behaves the same in the menu.
- **Shortcuts stay current.** A user rebinding a command sees the new chord in
  both places.
- **One more flag is all a new per-agent command needs.**

A hand-written action list would drift from the palette immediately, and the
palette is where the product's command vocabulary lives (the #394 command
rewrite).

### D2. Commands learn an explicit target

`CommandContext` gains `target?: SessionId`, and one helper replaces the
focus lookup:

```ts
export function commandTarget(ctx: Pick<CommandContext, 'workspace' | 'target'>): SessionId | null {
  return ctx.target ?? commandTargetSessionId(ctx.workspace)
}
```

- **Palette and keyboard:** runs pass no target, so they behave exactly as
  today.
- **The menu:** it passes the clicked row's session id.
- **Commands that call a `*Focused*` wrapper** switch to the explicit-id
  method they wrap (for example `reloadFocusedAgent()` →
  `reloadSessionAgent(id)`, `closeFocused()` →
  `closeSession(id, { killCaller: 'close.context-menu' })`). A wrapper that
  re-reads focus after the target was resolved is exactly how the WRONG agent
  gets acted on.

**Only converted commands may opt in.** A command gets `contextMenu`
metadata only in the same change that makes its `when` and `run` use
`commandTarget(ctx)` all the way down. A test runs every opted-in command
with `target` set to an agent that is NOT the focused one, and asserts that
the effect lands on the target and nothing touches the focused agent. This is
the guard against the silent re-addressing class of bug (#816: the wrong
agent acted on is worse than no action).

Rejected alternative: focus the row first, then run the ordinary command.
That is what the user has to do today. It moves the agent into a lane and
replaces what that lane showed, which is the exact detour this feature
removes.

### D3. A native menu (the browser pocket pattern), through one generic IPC

Recommended over a hand-built React menu:
- **It looks and behaves like every other macOS menu.** Keyboard navigation,
  type-to-select, VoiceOver, submenus and edge-of-screen placement all come
  for free.
- **It draws over everything**, including the browser pocket's `<webview>`
  and outside the window bounds, which a DOM menu cannot do.
- **Shortcuts show natively.** On macOS a context-menu item shows its
  accelerator without claiming that key outside the menu.
- **It is proven here.** The pocket menu already does submenus, radio items,
  confirmation and a stale-state drop.

Shape: a generic `menus:popup` IPC (it deliberately does not name sessions).
- **The renderer sends a serialisable template:** id, label, enabled,
  `checked`/`radio`, a display-only accelerator, submenu and separator.
- **Main** builds it, pops it at the cursor (or at a given point for keyboard
  opening), and resolves with the chosen item id, or null.
- **The renderer maps the id back** to a command and runs it with the
  captured target.

The same IPC serves later surfaces (lane chips, pane header, project tabs)
with no new main-process code.

Main never receives callbacks or commands, only data. Nothing the renderer
sends can make main run anything except show a menu and return an id.

Cost accepted: native menus cannot show the colour swatches as coloured
chips. The Colour Flag submenu uses the flag names with a ● glyph (matching
their order in the picker) and a ✓ on the current one.

### D4. What the menu contains (v1)

Grouped, with separators between groups. `(shortcut)` marks where an
item's effective keybinding shows, when it has one. An item is omitted, not greyed out,
when its `when` is false for that agent. This is the palette's rule too, and
it keeps a terminal's menu short.

```
┌──────────────────────────────────────────────┐
│ Show in Lane 2                               │  open
│ Show in Spotlight                            │
├──────────────────────────────────────────────┤
│ Set Title…                                   │  identity
│ Colour Flag                                 ▸│  ● Red ● Orange … ✓ None
│ Pin Session                  (or Unpin)      │
├──────────────────────────────────────────────┤
│ Reload Agent                                 │  agent
│ Switch Provider…                             │
│ Agent MCP Servers…                           │
│ Duplicate Agent                              │
│ Rewind to Prompt…                            │
│ View Prompts…                                │
│ TLDR History…                                │
│ Stop Goal Loop               (only when on)  │
├──────────────────────────────────────────────┤
│ Copy Resume Command                          │  copy
│ Copy Last Response                           │
├──────────────────────────────────────────────┤
│ Close Agent…                      (shortcut) │  close
└──────────────────────────────────────────────┘
```

Notes on specific items:

- **Show in Lane N:** exactly what a left click does, named with the real
  lane (`targetLaneIndex`). It is omitted for a disabled row, whose agent is
  already shown in another lane of this grid row.
- **Pin / Unpin:** there is no per-agent Pin command today (only the Pin
  Agents… modal and Unpin Session). v1 adds `pin-agent` "Pin Session", backed
  by `pinSession(id)`, as a palette command too, so the palette and the menu
  stay symmetrical.
- **Colour Flag:** a submenu, not the picker modal, because a menu choice is
  one step shorter. The existing `dispatch.color-flag.set` picker stays in the
  palette.
- **Close Agent…** runs `closeSession(id)`, so every existing safety rule
  applies unchanged: an idle agent closes with Undo, and a live agent or a
  linked cascade asks for confirmation. A menu click is not treated as
  pre-confirmation.
- **Terminal rows** get the identity, Copy and Close groups. **Extension
  views** get identity and Close. This falls out of each command's `when`, with
  no special casing.
- **Not in v1:**
  - Root Management: confirmation-gated, and deliberately rare.
  - Soft Reload, the debug commands, and the composer commands: they act on a
    composer the user is not looking at.
  - "Open in New Window" and "Move to Tab": no such commands exist yet.

### D5. Behaviour details

- **Right-click never selects.** `onContextMenu` calls preventDefault and does
  not call `focusSessionInTab`. The row gets a `data-menu-open` highlight while
  its menu is open, so the user can see which agent the menu is for.
- **The target is captured when the menu opens.** It is also re-checked when
  the menu resolves. If the session was closed or replaced in the meantime,
  the choice is dropped with a short toast ("That agent is no longer
  open."), the pocket's stale-state rule.
  - A reload changes session ids, so a menu opened before a reload finished is
    also dropped rather than retargeted.
- **Keyboard:** the ContextMenu key or Shift+F10 on a focused row opens the
  same menu, anchored to the row (the Explorer's `editor.context-menu`
  precedent, declared in the control-interactions catalog).
- **Mouse chords win.** If `event.defaultPrevented` (the mouse arbiter is
  holding a chord anchor), the row does not open its menu.
- **Scope of v1:** Sessions list rows (project and Pinned sections). The same
  handler on the lane chip strip (`DispatchMiniList`) and on the pane header
  label is a small follow-up once v1 is proven; the IPC and the command
  metadata already support them.

## Plan

Each task ends green on `npx tsc -b` and its targeted tests. There is one
full-suite run at the end.

### Task 1: Explicit command target (D2)

- Add `target?: SessionId` to `CommandContext` and a `commandTarget(ctx)`
  helper beside `commandTargetSessionId`.
- `dispatchCommand` and `executeCommand` accept an optional target and put it
  on the context. The palette, keybindings, the app menu and the control route
  pass none.
- Convert the v1 commands (listed in D4) to `commandTarget(ctx)` in both
  `when` and `run`, replacing `*Focused*` wrappers with their explicit-id
  methods.
- Add `pin-agent` "Pin Session".
- Tests:
  - a table test runs every converted command with `target` = an unfocused
    agent and asserts the effect lands on the target, with the focused agent
    untouched;
  - palette runs with no target behave as before (the existing command
    tests).

### Task 2: `contextMenu` metadata and the menu model

- Add `contextMenu?: { group, order }` to `CommandDef`, and opt the v1
  commands in.
- A pure `buildSessionContextMenu({ sessionId, ctx, registry })` returns the
  serialisable template:
  - groups, `when` filtering and the effective shortcuts;
  - "Show in Lane N" and the Colour Flag submenu, the two items that are not
    catalog commands.
- Tests: menus for a Claude agent, a Codex agent, a terminal, an extension
  view, a pinned agent, a disabled row and an agent with a live goal loop,
  built from real fixtures, not a mocked registry.
- Also a catalog test: every command with `contextMenu` metadata is in the
  Task 1 explicit-target table. Adding the flag to an unconverted command
  fails CI.

### Task 3: Native popup IPC (D3)

- `src/main/menus/popupMenu.ts`:
  - validates the template (bounded depth and item count, string ids, no
    roles);
  - builds it with `Menu.buildFromTemplate`;
  - pops it at a point on the sender's window;
  - resolves with the chosen id or null.
- `ipc/menus.ts` registers `menus:popup`, with preload `showPopupMenu`.
- Tests:
  - template validation rejects roles, unknown fields, depth over 2 and more
    than 60 items;
  - the item-to-id mapping round-trips, with a stubbed `Menu` in the style of
    `browserPocket/nativeMenus.test.ts`.

### Task 4: Wire the Sessions list (D5)

- `DispatchAgentListRow`:
  - `onContextMenu` and ContextMenu/Shift+F10 open the menu for `row.sessionId`
    and set `data-menu-open`;
  - on resolve, re-check that the session still exists, then run the command
    with `target`, or apply the flag, pin or show-in-lane directly.
- Declare the keyboard binding in the dispatch control interactions.
- Renderer tests:
  - a right-click does not select the row and sends the expected template;
  - choosing Close runs `closeSession` for that row, not for the focused agent;
  - a session closed while the menu was open drops the choice with the toast;
  - a disabled row still opens its menu, without "Show in Lane".

### Task 5: Docs and verification

- A control reference entry for the menu, and a `RELEASE.md`-style note in the
  PR.
- Run `npx tsc -b`, the targeted tests, and the full suite once.
- Open a PR and run the review round.

## Open questions for the user

1. **Native menu (recommended) or a React menu styled like the app?** Native
   matches macOS and works over the browser pocket. React would allow coloured
   flag chips and live badges inside the menu.
2. **v1 scope:** the Sessions list only (recommended), or also the lane chip
   strip and the pane header in the same PR?
3. **Actions:** anything to add or drop from the D4 list? For example, whether
   Close Agent should be in the menu at all, or behind "More ▸".
