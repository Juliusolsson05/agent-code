# Dispatch Pin Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pin Agents…" command in Dispatch mode that opens a multi-select modal (Space toggles, Enter accepts) and pins the chosen agents into a new always-visible "Pinned" section at the top of the dispatch list. Pinned agents render with a small project chip so cross-project pins remain disambiguable. A second `Unpin Agent` command unpins the currently-focused pinned row for keyboard-driven flow.

**Architecture:** Pin state lives in `WorkspaceState.pinnedSessionIds: SessionId[]` — an *ordered* array (pin order == display order) persisted to `workspace.json` alongside `detachedSessions`. The pinned section is **always shown** regardless of dispatch scope (the whole point of pins is that they survive the project-vs-global toggle — that's also why the project chip matters). A new modal lives at `src/renderer/src/features/dispatch-pin/PinAgentsModal.tsx`, mounted in `App.tsx` like the existing Reorder Tabs modal; the trigger flag (`pinAgentsOpen`) is on `uiShell` because the modal is transient command chrome, not workspace data. Modal toggle UX matches the CommandPalette idiom: Space toggles the focused row, Enter commits, Escape cancels.

**Tech Stack:** TypeScript / React, zustand workspace + uiShell stores, electron-vite renderer build.

---

## File Structure

**Create:**
- `src/renderer/src/features/dispatch-pin/PinAgentsModal.tsx` — the modal component (multi-select with keyboard).
- `src/renderer/src/features/dispatch-pin/usePinAgentsKeybinds.ts` — pure keybind logic split out for readability (Space / Enter / Esc / Up / Down). Following the precedent of `useComposerKeybinds` in `TileLeaf/`.

**Modify:**
- `src/renderer/src/workspace/types.ts` — add `pinnedSessionIds: SessionId[]` to `WorkspaceState`.
- `src/renderer/src/workspace/workspaceState.ts` — initialize `pinnedSessionIds: []` in `emptyRuntime()`.
- `src/renderer/src/workspace/persistence.ts` — save + coerce `pinnedSessionIds`.
- `src/renderer/src/workspace/dispatch/dispatchSelectors.ts` — add `buildPinnedDispatchRows()` and update `buildDispatchGroups()` to skip pinned sessions from regular groups.
- `src/renderer/src/workspace/dispatch/DispatchLayout.tsx` — render new `<DispatchPinnedGroup>` block above the existing groups; each row shows a project chip.
- `src/renderer/src/workspace/hook/actions/dispatch.ts` — three new actions: `pinSession`, `unpinSession`, `setPinnedSessionIds`.
- `src/renderer/src/workspace/hook/index.ts` — export the new actions.
- `src/renderer/src/workspace/hook/invalidation/effects.ts` (or wherever session removal cleanup lives) — prune `pinnedSessionIds` when a session disappears from `state.sessions`.
- `src/renderer/src/app-state/uiShell/types.ts` — add `pinAgentsOpen: boolean`.
- `src/renderer/src/app-state/uiShell/slice.ts` — `openPinAgents` / `closePinAgents` actions.
- `src/renderer/src/app/App.tsx` — mount `<PinAgentsModal>` next to the Reorder Tabs modal.
- `src/renderer/src/features/command-palette/types.ts` — add `openPinAgents: () => void` to the command context's `ui` shape.
- `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` — accept + forward the `openPinAgents` prop.
- `src/renderer/src/features/workspace/commands/paneCommands.ts` — register `pin-agents` and `unpin-agent` commands (both dispatch-mode-only).

**Do not modify:**
- The renderer's Codex panes, terminal panes, agent activity modal, etc. Pin is a Dispatch-only concern.
- Main process — pins are pure renderer state persisted via the existing `workspace.json` flow. No new IPC.

**No new tests, no new `test:*` scripts.** Per `feedback_no_test_bloat.md`. The reorder-tabs and reader modals shipped without dedicated tests by the same convention; smoke verification is in Task 12.

---

## Task 1: Add `pinnedSessionIds` to the workspace state type

**Files:**
- Modify: `src/renderer/src/workspace/types.ts:177-197`

- [ ] **Step 1: Add the field to `WorkspaceState`**

Find the existing `WorkspaceState` declaration. Add `pinnedSessionIds` after `buried` so the schema reads in lifecycle order (placed → detached → buried → pinned):

```ts
export type WorkspaceState = {
  tabs: Tab[]
  activeTabId: TabId
  dispatchMode: DispatchModeState | null
  sessions: Record<SessionId, SessionMeta>
  detachedSessions: Record<SessionId, DetachedSessionRecord>
  buried: BuriedPaneRecord[]
  /**
   * Ordered list of session IDs the user has explicitly pinned to the
   * top of the dispatch list. ORDER MATTERS — `pinnedSessionIds[0]`
   * renders at the top of the Pinned section. Adding via pinSession
   * appends to the tail (newest pin sinks to the bottom of Pinned)
   * unless explicitly reordered.
   *
   * Pinned sessions are ALWAYS visible in the Pinned section
   * regardless of dispatch scope (project vs global) — the whole
   * point of pins is that they survive the scope toggle. To keep the
   * cross-project view readable, each pinned row in
   * DispatchAgentList renders a small project chip (tab letter +
   * project basename). See dispatchSelectors.buildPinnedDispatchRows.
   *
   * Sessions that disappear from `sessions` are auto-pruned from
   * this array by the cleanup pass in
   * `workspace/hook/invalidation/effects.ts` so a killed session
   * doesn't linger in the Pinned section as a phantom row.
   */
  pinnedSessionIds: SessionId[]
}
```

- [ ] **Step 2: Type-check passes**

Run: `npm run build`
Expected: PASS for the renderer build; `workspaceState.ts` will fail because the field is missing from `emptyRuntime()` — fix in Task 2.

If you see an error in `persistence.ts` about a missing field too, ignore it for now — Task 3 covers it. Other unrelated callers of `WorkspaceState` (e.g. `dispatchSelectors`) only need the field for reads; `pinnedSessionIds` defaulting to undefined in older state objects is a real concern handled by the coerce in Task 3, not the type.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/workspace/types.ts
git commit -m "feat(dispatch): add pinnedSessionIds to WorkspaceState type"
```

---

## Task 2: Initialize `pinnedSessionIds` in `emptyRuntime()`

**Files:**
- Modify: `src/renderer/src/workspace/workspaceState.ts`

- [ ] **Step 1: Locate `emptyRuntime()`**

```bash
grep -n "emptyRuntime\|detachedSessions: {}" src/renderer/src/workspace/workspaceState.ts | head -5
```

You're looking for the initializer that produces a `WorkspaceState` for a fresh workspace.

- [ ] **Step 2: Add the field**

Inside `emptyRuntime()`, add `pinnedSessionIds: [],` immediately after the `buried: []` line:

```ts
return {
  // … existing fields …
  detachedSessions: {},
  buried: [],
  pinnedSessionIds: [],
}
```

- [ ] **Step 3: Type-check passes for workspaceState.ts**

Run: `npm run build`
Expected: workspaceState.ts errors gone. `persistence.ts` may still error — Task 3.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/workspaceState.ts
git commit -m "feat(dispatch): default pinnedSessionIds to [] in fresh workspace state"
```

---

## Task 3: Persist + coerce `pinnedSessionIds`

**Files:**
- Modify: `src/renderer/src/workspace/persistence.ts`

- [ ] **Step 1: Find the persisted-state type + coerce path**

```bash
grep -n "detachedSessions\|sessions:\|pinnedSessionIds\|coerce" src/renderer/src/workspace/persistence.ts | head -15
```

You'll see a `PersistedWorkspace` (or similar) type with optional fields, and a function that hydrates a `WorkspaceState` from disk.

- [ ] **Step 2: Add to the persisted shape**

Inside the persisted-workspace type:

```ts
type PersistedWorkspace = {
  // … existing fields …
  sessions: Record<SessionId, SessionMeta>
  detachedSessions?: Record<SessionId, DetachedSessionRecord>
  buried?: BuriedPaneRecord[]
  /** Ordered pin list. Optional because older workspace.json files
   *  predate this field; coerce defaults to []. */
  pinnedSessionIds?: SessionId[]
}
```

- [ ] **Step 3: Coerce on load**

Inside the load/hydrate function, immediately after the existing detachedSessions/buried fallbacks:

```ts
pinnedSessionIds: Array.isArray(persisted.pinnedSessionIds)
  ? persisted.pinnedSessionIds.filter(
      (id): id is SessionId => typeof id === 'string' && id.length > 0,
    )
  : [],
```

- [ ] **Step 4: Save on write**

In the function that serializes `WorkspaceState` back to `workspace.json`, include the field directly — `pinnedSessionIds` is always an array, never undefined at runtime, so no fallback needed:

```ts
return {
  // … existing fields …
  pinnedSessionIds: state.pinnedSessionIds,
}
```

- [ ] **Step 5: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/persistence.ts
git commit -m "feat(dispatch): persist pinnedSessionIds + coerce missing/legacy"
```

---

## Task 4: Auto-prune pinned IDs when sessions disappear

**Files:**
- Modify: `src/renderer/src/workspace/hook/invalidation/effects.ts` (cleanup pass) — confirm with `grep -n "delete.*sessions\|prune\|cleanup" src/renderer/src/workspace/hook/invalidation/effects.ts | head -10` if the path differs

- [ ] **Step 1: Find an existing prune precedent**

The workspace already prunes orphaned `detachedSessions` and `buried` entries on session removal. Find the function that does this:

```bash
grep -rn "detachedSessions\[.*\]\|delete.*detachedSessions\|filter.*sessions\[" src/renderer/src/workspace/ | head -10
```

The same function (or an effect that runs after every state mutation) should drop pinnedSessionIds entries whose session no longer exists.

- [ ] **Step 2: Add the prune logic**

Inside the relevant cleanup pass:

```ts
const validPinIds = state.pinnedSessionIds.filter(
  id => state.sessions[id] !== undefined,
)
if (validPinIds.length !== state.pinnedSessionIds.length) {
  // A pinned session was killed / removed. Drop it from the array
  // immediately so the Pinned section doesn't render a phantom row
  // that resolves to nothing on click. Sessions can be re-pinned by
  // the user later if they're spawned again with the same id (they
  // won't be — session ids are uuid).
  return { ...state, pinnedSessionIds: validPinIds }
}
```

If no clean prune pass exists in invalidation/effects.ts, put it in `workspace/hook/actions/session.ts` next to wherever sessions get removed (`killSession`, etc.). Either is acceptable — the invariant is "after any reducer that removes a session, `pinnedSessionIds` contains no orphans."

- [ ] **Step 3: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/hook/invalidation/effects.ts
git commit -m "feat(dispatch): prune killed sessions from pinnedSessionIds"
```

---

## Task 5: Pin/unpin/setOrder actions on the workspace hook

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/dispatch.ts`
- Modify: `src/renderer/src/workspace/hook/index.ts` (export the new actions)

- [ ] **Step 1: Extend the return type of `useDispatchActions`**

Open `src/renderer/src/workspace/hook/actions/dispatch.ts` and find the function's return-shape type. Add three methods after `focusDispatchSession`:

```ts
): {
  enterDispatchMode: (scope?: DispatchModeState['scope']) => Promise<void>
  exitDispatchMode: () => void
  setDispatchScope: (scope: DispatchModeState['scope']) => Promise<void>
  ensureDispatchTerminal: (tabId?: TabId) => Promise<SessionId | null>
  focusDispatchSession: (tabId: TabId, sessionId: SessionId) => void
  pinSession: (sessionId: SessionId) => void
  unpinSession: (sessionId: SessionId) => void
  setPinnedSessionIds: (ids: SessionId[]) => void
} {
```

- [ ] **Step 2: Implement the three actions**

Inside the hook body, add the three callbacks just before the `return` statement:

```ts
const pinSession = useCallback(
  (sessionId: SessionId) => {
    setState(prev => {
      if (prev.pinnedSessionIds.includes(sessionId)) return prev
      // Reject pinning non-existent or terminal sessions. The
      // command's `when` guard already prevents this at the call
      // site, but a defensive reducer check keeps the invariant
      // local: pinnedSessionIds[i] -> sessions[id] is always an
      // agent. Terminals don't get pinned — they're per-tab
      // infrastructure, not a unit the user "pins to favorites."
      const meta = prev.sessions[sessionId]
      if (!meta || meta.kind === 'terminal') return prev
      return {
        ...prev,
        pinnedSessionIds: [...prev.pinnedSessionIds, sessionId],
      }
    })
  },
  [setState],
)

const unpinSession = useCallback(
  (sessionId: SessionId) => {
    setState(prev => {
      if (!prev.pinnedSessionIds.includes(sessionId)) return prev
      return {
        ...prev,
        pinnedSessionIds: prev.pinnedSessionIds.filter(id => id !== sessionId),
      }
    })
  },
  [setState],
)

const setPinnedSessionIds = useCallback(
  (ids: SessionId[]) => {
    setState(prev => {
      // Filter against the live sessions snapshot at write time so a
      // stale modal selection (the user pinned X, then X was killed
      // before they hit Enter) can never reintroduce an orphan into
      // the array. Same defensive shape as the reducer's auto-prune.
      const filtered = ids.filter(id => {
        const meta = prev.sessions[id]
        return meta !== undefined && meta.kind !== 'terminal'
      })
      // Deduplicate while preserving order (first occurrence wins).
      const seen = new Set<SessionId>()
      const ordered: SessionId[] = []
      for (const id of filtered) {
        if (seen.has(id)) continue
        seen.add(id)
        ordered.push(id)
      }
      return { ...prev, pinnedSessionIds: ordered }
    })
  },
  [setState],
)
```

Add `pinSession`, `unpinSession`, and `setPinnedSessionIds` to the returned object at the bottom of the hook:

```ts
return {
  enterDispatchMode,
  exitDispatchMode,
  setDispatchScope,
  ensureDispatchTerminal,
  focusDispatchSession,
  pinSession,
  unpinSession,
  setPinnedSessionIds,
}
```

- [ ] **Step 3: Re-export from the workspace hook**

Open `src/renderer/src/workspace/hook/index.ts`. Find the block that re-exports dispatch actions (it'll have lines like `enterDispatchMode: dispatchActions.enterDispatchMode`). Add three more:

```ts
pinSession: dispatchActions.pinSession,
unpinSession: dispatchActions.unpinSession,
setPinnedSessionIds: dispatchActions.setPinnedSessionIds,
```

- [ ] **Step 4: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/hook/actions/dispatch.ts \
        src/renderer/src/workspace/hook/index.ts
git commit -m "feat(dispatch): pinSession/unpinSession/setPinnedSessionIds actions"
```

---

## Task 6: Selector for the Pinned section + filter pinned out of regular groups

**Files:**
- Modify: `src/renderer/src/workspace/dispatch/dispatchSelectors.ts`

- [ ] **Step 1: Add a pinned-row builder + helper**

After `findTerminalSessionInTab`, add:

```ts
/**
 * Build the rows that render in the "Pinned" section at the top of
 * DispatchAgentList. Order matches `state.pinnedSessionIds` exactly
 * (first pinned == top of section).
 *
 * Unlike buildDispatchGroups, this is NOT scope-aware: pins are
 * cross-project by design and the Pinned section always shows every
 * pin regardless of whether dispatch is in project or global scope.
 * The per-row `tabIndex` is still returned so the renderer can show
 * the small project chip and so cmd+N keyboard dispatch resolves to
 * the right tab.
 *
 * Pinned sessions that no longer exist are silently dropped. The
 * `pinnedSessionIds` auto-prune pass in
 * `workspace/hook/invalidation/effects.ts` should catch these on
 * normal removal, but a stale entry surviving the reducer cycle
 * (e.g. a race during fresh-workspace bootstrap) must not produce
 * a row that resolves to nothing.
 */
export function buildPinnedDispatchRows(
  state: WorkspaceState,
): DispatchAgentRow[] {
  const rows: DispatchAgentRow[] = []
  let pinnedIndex = 1
  for (const sessionId of state.pinnedSessionIds) {
    const meta = state.sessions[sessionId]
    if (!meta || meta.kind === 'terminal') continue
    // Locate the owning tab. A pinned agent that's detached has its
    // tab id on `detachedSessions[sessionId].projectTabId`; a
    // grid-placed pinned agent is a leaf in some tab's tree. We do
    // the lookup in that order because detachedSessions is O(1) and
    // catches the "background pinned agent" case the user is likely
    // pinning in the first place.
    const detached = state.detachedSessions[sessionId]
    let tabId: TabId | null = null
    let placement: 'grid' | 'detached' = 'grid'
    if (detached) {
      tabId = detached.projectTabId
      placement = 'detached'
    } else {
      const owner = state.tabs.find(tab =>
        collectLeaves(tab.root).includes(sessionId),
      )
      tabId = owner?.id ?? null
    }
    if (!tabId) continue
    const tabIndex = state.tabs.findIndex(tab => tab.id === tabId)
    const tab = state.tabs[tabIndex]
    if (!tab) continue
    rows.push({
      key: `pinned:${sessionId}`,
      label: `★${pinnedIndex}`,
      globalIndex: pinnedIndex,
      tabId,
      tabTitle: tab.title,
      tabIndex,
      sessionId,
      kind: meta.kind,
      title: sessionTitle(meta),
      placement,
    })
    pinnedIndex += 1
  }
  return rows
}

/**
 * Returns true if a sessionId is in the pinned list. Used by
 * buildDispatchGroups to skip pinned sessions in the regular groups
 * — a session is in EITHER the Pinned section or its project group,
 * never both. Same exclusivity invariant as detached-vs-grid.
 */
export function isPinned(state: WorkspaceState, sessionId: SessionId): boolean {
  return state.pinnedSessionIds.includes(sessionId)
}
```

- [ ] **Step 2: Skip pinned sessions in `buildDispatchGroups`**

In the existing `buildDispatchGroups` function, immediately after the `gridSessionIds` / `detachedSessionIds` lines, filter both:

```ts
const pinnedSet = new Set(state.pinnedSessionIds)
const gridSessionIds = collectLeaves(tab.root)
  .filter(sessionId => state.sessions[sessionId]?.kind !== 'terminal')
  .filter(sessionId => !pinnedSet.has(sessionId))
const detachedSessionIds = detachedDispatchSessionIdsForTab(state, tab.id)
  .filter(sessionId => !pinnedSet.has(sessionId))
```

- [ ] **Step 3: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/dispatch/dispatchSelectors.ts
git commit -m "feat(dispatch): buildPinnedDispatchRows + skip pinned in regular groups"
```

---

## Task 7: Render the Pinned group in DispatchAgentList

**Files:**
- Modify: `src/renderer/src/workspace/dispatch/DispatchLayout.tsx`

- [ ] **Step 1: Pass pinned rows into `DispatchAgentList`**

Find the `<DispatchAgentList>` invocation (search `<DispatchAgentList`). Compute `pinnedRows` next to `groups` at the top of the parent `DispatchLayout` function:

```ts
const groups = useMemo(
  () => buildDispatchGroups(workspace.state),
  [workspace.state],
)
const pinnedRows = useMemo(
  () => buildPinnedDispatchRows(workspace.state),
  [workspace.state],
)
```

Update the import line at the top of the file:

```ts
import {
  buildDispatchGroups,
  buildPinnedDispatchRows,
  findTerminalSessionInTab,
  flattenDispatchRows,
  selectVisibleDispatchRow,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
```

Pass `pinnedRows` to `DispatchAgentList`:

```tsx
<DispatchAgentList
  groups={groups}
  pinnedRows={pinnedRows}
  activeSessionId={activeRow?.sessionId ?? null}
  dispatchScope={workspace.state.dispatchMode?.scope === 'global' ? 'global' : 'project'}
  focusSessionInTab={workspace.focusDispatchSession}
  showWorktreeBadges={showWorktreeBadges}
/>
```

Update `flattenDispatchRows` calls in the same file to prepend the pinned rows (they participate in cmd+N keyboard dispatch). Find every `flattenDispatchRows(groups)` and replace with:

```ts
[...pinnedRows, ...flattenDispatchRows(groups)]
```

- [ ] **Step 2: Add `pinnedRows` to the `DispatchAgentList` props type**

Inside the same file, find `function DispatchAgentList`. Update the props:

```tsx
const DispatchAgentList = memo(function DispatchAgentList({
  groups,
  pinnedRows,
  activeSessionId,
  dispatchScope,
  focusSessionInTab,
  showWorktreeBadges,
}: {
  groups: ReturnType<typeof buildDispatchGroups>
  pinnedRows: DispatchAgentRow[]
  activeSessionId: string | null
  dispatchScope: 'global' | 'project'
  focusSessionInTab: Workspace['focusSessionInTab']
  showWorktreeBadges: boolean
}) {
```

- [ ] **Step 3: Render the pinned section above the regular groups**

In the JSX, after `<div data-dispatch-list-header …>`, before `{groups.map(...)}`, add:

```tsx
{pinnedRows.length > 0 && (
  <div className="border-b border-border" data-dispatch-pinned-group="true">
    <DispatchGroupHeader title="Pinned" rows={pinnedRows} />
    <div>
      {pinnedRows.map(row => (
        <DispatchAgentListRow
          key={row.key}
          row={row}
          active={row.sessionId === activeSessionId}
          showWorktreeBadges={showWorktreeBadges}
          focusSessionInTab={focusSessionInTab}
          // Pinned rows get a small project chip (tab letter +
          // basename of tab title) so cross-project pins stay
          // disambiguable. Regular rows don't need this because
          // their containing group's header already names the
          // project.
          projectChip={`${tabIndexLabel(row.tabIndex)} · ${row.tabTitle}`}
        />
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Add `projectChip` to `DispatchAgentListRow`**

Find `DispatchAgentListRow` in the same file (or in a sibling file under `dispatch/`). Add an optional prop `projectChip?: string` and render it as a small label next to the agent's title. Suggested markup (Tailwind, matching the existing visual idiom):

```tsx
{projectChip && (
  <span className="ml-2 rounded-sm bg-bg-muted px-1 py-[1px] text-[10px] uppercase tracking-tight text-muted">
    {projectChip}
  </span>
)}
```

If `tabIndexLabel` isn't already imported, add it:

```ts
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
```

- [ ] **Step 5: Build + visual check**

```bash
npm run build
npm run dev
```

Manually:
1. Open a workspace with at least 2 tabs and 2 agents per tab.
2. (Will be triggered by the command in Task 11 — for this task's verification, temporarily seed pins by hand: open DevTools console, run `useAppStore.setState(s => ({ workspace: { ...s.workspace, pinnedSessionIds: [/* paste two sessionIds */] } }))`.)
3. Confirm the Pinned section appears at the top of the dispatch list with the right rows, project chips visible.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/dispatch/DispatchLayout.tsx
git commit -m "feat(dispatch): render Pinned section + per-row project chips"
```

---

## Task 8: uiShell state for the modal trigger

**Files:**
- Modify: `src/renderer/src/app-state/uiShell/types.ts`
- Modify: `src/renderer/src/app-state/uiShell/slice.ts`

- [ ] **Step 1: Add the flag to the state type**

Open `src/renderer/src/app-state/uiShell/types.ts`. Add `pinAgentsOpen` next to `reorderTabsOpen`:

```ts
/** When true, the Pin Agents multi-select modal is open. Lives on
 *  uiShell (not WorkspaceState) for the same reason reorderTabsOpen
 *  does: it's transient command chrome, not workspace data. The
 *  resulting pin order is persisted through WorkspaceState only
 *  after the user confirms with Enter. Keeping the draft selection
 *  out of WorkspaceState prevents autosave from recording
 *  half-finished pin sessions the user later cancels with Escape. */
pinAgentsOpen: boolean
```

- [ ] **Step 2: Add open/close actions to the slice**

Open `src/renderer/src/app-state/uiShell/slice.ts`. Find the `openReorderTabs`/`closeReorderTabs` block. Right after it, add the parallel pair:

```ts
openPinAgents: () =>
  set({ pinAgentsOpen: true }, false, 'uiShell/openPinAgents'),
closePinAgents: () =>
  set({ pinAgentsOpen: false }, false, 'uiShell/closePinAgents'),
```

And initialize `pinAgentsOpen: false` in the initial-state object next to `reorderTabsOpen: false`.

- [ ] **Step 3: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/app-state/uiShell/types.ts \
        src/renderer/src/app-state/uiShell/slice.ts
git commit -m "feat(dispatch): pinAgentsOpen flag on uiShell"
```

---

## Task 9: PinAgentsModal component

**Files:**
- Create: `src/renderer/src/features/dispatch-pin/PinAgentsModal.tsx`
- Create: `src/renderer/src/features/dispatch-pin/usePinAgentsKeybinds.ts`

- [ ] **Step 1: The keybinds hook (pure)**

`src/renderer/src/features/dispatch-pin/usePinAgentsKeybinds.ts`:

```ts
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'

import type { SessionId } from '@renderer/workspace/types'

// Pure keybind logic for the Pin Agents modal — kept separate from
// the JSX in PinAgentsModal.tsx so reasoning about navigation/toggle
// state is easy to read without scrolling past Tailwind. Same split
// as `useComposerKeybinds` next to `ComposerInput` in TileLeaf/.
//
// The selection state is held LOCALLY in the modal: the workspace
// reducer only sees the committed list when the user presses Enter.
// That preserves the "Escape cancels" invariant promised by the
// uiShell.pinAgentsOpen docstring.

export type UsePinAgentsKeybindsArgs = {
  rows: { sessionId: SessionId }[]
  /** Initial selection — the set of currently-pinned sessions. */
  initialSelectedIds: SessionId[]
  /** Called with the final ordered selection when the user presses Enter. */
  onCommit: (ids: SessionId[]) => void
  /** Called when the user presses Escape or otherwise cancels. */
  onCancel: () => void
}

export function usePinAgentsKeybinds({
  rows,
  initialSelectedIds,
  onCommit,
  onCancel,
}: UsePinAgentsKeybindsArgs) {
  const [selectedIds, setSelectedIds] = useState<SessionId[]>(initialSelectedIds)
  const [focusedIndex, setFocusedIndex] = useState(0)

  // If the rows array changes shape (e.g. an agent got killed while
  // the modal was open), clamp focus into range so Down/Up still
  // works after the layout shifted underneath us.
  useEffect(() => {
    setFocusedIndex(prev => {
      if (rows.length === 0) return 0
      return Math.min(prev, rows.length - 1)
    })
  }, [rows.length])

  const toggle = useCallback(
    (sessionId: SessionId) => {
      setSelectedIds(prev => {
        if (prev.includes(sessionId)) {
          return prev.filter(id => id !== sessionId)
        }
        // Append-on-pin preserves user-chosen order: the order in
        // which they Space'd through the list is the order pins
        // render in. This is the explicit spec request — "order you
        // pin in is order it will display."
        return [...prev, sessionId]
      })
    },
    [],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        onCommit(selectedIds)
        return
      }
      if (event.key === 'ArrowDown' || (event.key === 'j' && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault()
        setFocusedIndex(prev => Math.min(rows.length - 1, prev + 1))
        return
      }
      if (event.key === 'ArrowUp' || (event.key === 'k' && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault()
        setFocusedIndex(prev => Math.max(0, prev - 1))
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        const row = rows[focusedIndex]
        if (row) toggle(row.sessionId)
        return
      }
    },
    [focusedIndex, onCancel, onCommit, rows, selectedIds, toggle],
  )

  return { selectedIds, focusedIndex, setFocusedIndex, onKeyDown, toggle }
}
```

- [ ] **Step 2: The modal component**

`src/renderer/src/features/dispatch-pin/PinAgentsModal.tsx`:

```tsx
import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'

import { useAppStore } from '@renderer/app-state/hooks'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { SessionId } from '@renderer/workspace/types'
import { usePinAgentsKeybinds } from './usePinAgentsKeybinds'

// Modal for the `Pin Agents…` command. Multi-select with Space to
// toggle, Enter to commit, Escape to cancel. Renders into a portal
// so it doesn't inherit overflow / z-index quirks from the dispatch
// list region. Same shape as the Reorder Tabs modal in
// features/tile-tabs/ but with toggle semantics instead of
// drag-reorder.
//
// Row selection: we enumerate EVERY agent session in the workspace
// (regardless of tab, regardless of detached vs grid placement,
// regardless of dispatch scope). Terminals are skipped — they are
// per-tab infrastructure, not "agents the user pins to favorites."
// Pre-selected rows are the ones already in
// workspace.state.pinnedSessionIds; the user can uncheck them with
// Space to unpin in the same surface.

type ModalRow = {
  sessionId: SessionId
  tabId: string
  tabTitle: string
  tabIndex: number
  title: string
}

type Props = {
  open: boolean
  onClose: () => void
}

export function PinAgentsModal({ open, onClose }: Props) {
  const workspaceState = useAppStore(state => state.workspace)
  const setPinnedSessionIds = useAppStore(state => state.setPinnedSessionIds)

  // Build the candidate rows. Grid leaves + detached agents from
  // every tab, terminals excluded. Order: pinned first (in pin
  // order), then per-tab in tab order. Pinned-first means the user's
  // existing pins surface at the top when they open the modal — the
  // most common operation is "tweak my pins," not "scroll through
  // every agent in the workspace."
  const rows: ModalRow[] = useMemo(() => {
    if (!workspaceState) return []
    const allRows: ModalRow[] = []
    const pinnedSet = new Set(workspaceState.pinnedSessionIds)
    // Helper: build a ModalRow from a sessionId + owning tab.
    const buildRow = (sessionId: SessionId, tabId: string, tabIndex: number, tabTitle: string): ModalRow | null => {
      const meta = workspaceState.sessions[sessionId]
      if (!meta || meta.kind === 'terminal') return null
      return {
        sessionId,
        tabId,
        tabTitle,
        tabIndex,
        title: meta.title?.trim() || meta.cwd?.split('/').pop() || 'agent',
      }
    }
    // Pinned first, in order.
    for (const sessionId of workspaceState.pinnedSessionIds) {
      const owner = workspaceState.tabs.find(tab =>
        collectLeavesShallow(tab.root).includes(sessionId),
      ) ?? null
      const detached = workspaceState.detachedSessions[sessionId]
      const tabId = owner?.id ?? detached?.projectTabId ?? null
      if (!tabId) continue
      const tabIndex = workspaceState.tabs.findIndex(tab => tab.id === tabId)
      const tab = workspaceState.tabs[tabIndex]
      if (!tab) continue
      const row = buildRow(sessionId, tab.id, tabIndex, tab.title)
      if (row) allRows.push(row)
    }
    // Everyone else, tab-by-tab. Skip already-pinned (we just added them).
    workspaceState.tabs.forEach((tab, tabIndex) => {
      const gridIds = collectLeavesShallow(tab.root)
      const detachedIds = Object.values(workspaceState.detachedSessions)
        .filter(d => d.projectTabId === tab.id)
        .sort((a, b) => a.detachedAt - b.detachedAt)
        .map(d => d.sessionId)
      const combined = [...gridIds, ...detachedIds]
      for (const sessionId of combined) {
        if (pinnedSet.has(sessionId)) continue
        const row = buildRow(sessionId, tab.id, tabIndex, tab.title)
        if (row) allRows.push(row)
      }
    })
    return allRows
  }, [workspaceState])

  const { selectedIds, focusedIndex, setFocusedIndex, onKeyDown, toggle } = usePinAgentsKeybinds({
    rows,
    initialSelectedIds: workspaceState?.pinnedSessionIds ?? [],
    onCommit: ids => {
      setPinnedSessionIds(ids)
      onClose()
    },
    onCancel: onClose,
  })

  const focusContainerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (open) focusContainerRef.current?.focus()
  }, [open])

  if (!open) return null

  const selectedSet = new Set(selectedIds)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        className="w-[480px] max-h-[60vh] flex flex-col bg-surface border border-border rounded-md shadow-xl outline-none"
        tabIndex={-1}
        ref={focusContainerRef}
        onKeyDown={onKeyDown}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-border text-sm uppercase tracking-wide text-muted">
          Pin Agents
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted">No agents available to pin.</div>
          ) : (
            rows.map((row, i) => {
              const isSelected = selectedSet.has(row.sessionId)
              const isFocused = i === focusedIndex
              return (
                <div
                  key={row.sessionId}
                  data-focused={isFocused || undefined}
                  className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer ${
                    isFocused ? 'bg-bg-elevated' : ''
                  }`}
                  onMouseEnter={() => setFocusedIndex(i)}
                  onClick={() => toggle(row.sessionId)}
                >
                  <span className="w-4 inline-flex items-center justify-center text-xs">
                    {isSelected ? '★' : '·'}
                  </span>
                  <span className="text-xs text-muted tabular-nums">
                    {tabIndexLabel(row.tabIndex)}
                  </span>
                  <span className="flex-1 truncate text-sm">{row.title}</span>
                  <span className="text-[10px] uppercase tracking-tight text-muted truncate max-w-[140px]">
                    {row.tabTitle}
                  </span>
                </div>
              )
            })
          )}
        </div>
        <div className="px-3 py-2 border-t border-border text-[11px] text-muted flex items-center gap-3">
          <span><kbd>Space</kbd> toggle</span>
          <span><kbd>Enter</kbd> commit</span>
          <span><kbd>Esc</kbd> cancel</span>
          <span className="ml-auto">{selectedIds.length} pinned</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Tiny local helper so the modal doesn't import the whole tree-ops
// surface. Inlined deliberately because (a) it's read-only on the
// tree shape and (b) putting a renderer-only "shallow leaves" helper
// next to the full collectLeaves in treeOps would invite a future
// caller to use the wrong one. If you find yourself needing this in
// a second component, promote it to treeOps.
function collectLeavesShallow(root: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { kind?: string; sessionId?: string; a?: unknown; b?: unknown }
    if (n.kind === 'leaf' && typeof n.sessionId === 'string') {
      out.push(n.sessionId)
      return
    }
    walk(n.a)
    walk(n.b)
  }
  walk(root)
  return out
}
```

- [ ] **Step 3: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/dispatch-pin/
git commit -m "feat(dispatch): PinAgentsModal with Space-toggle / Enter-commit"
```

---

## Task 10: Mount the modal in App.tsx + wire CommandPalette UI

**Files:**
- Modify: `src/renderer/src/app/App.tsx`
- Modify: `src/renderer/src/features/command-palette/types.ts`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`

- [ ] **Step 1: Mount the modal in App.tsx**

Find the existing modal mounts (`<ReorderTabsModal>`, `<TileTabsModal>`, etc.) — search for `reorderTabsOpen`. Right next to them, add:

```tsx
import { PinAgentsModal } from '@renderer/features/dispatch-pin/PinAgentsModal'
// …
const pinAgentsOpen = useAppStore(state => state.pinAgentsOpen)
const closePinAgents = useAppStore(state => state.closePinAgents)
const openPinAgents = useAppStore(state => state.openPinAgents)
// …in the JSX, near <ReorderTabsModal>…
<PinAgentsModal open={pinAgentsOpen} onClose={closePinAgents} />
```

- [ ] **Step 2: Add `openPinAgents` to the command-palette context type**

Open `src/renderer/src/features/command-palette/types.ts`. Find the `ui` shape inside the command context. Add:

```ts
openPinAgents: () => void
```

- [ ] **Step 3: Forward through CommandPalette.tsx**

Open `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`. Find the `Props` type (search for `openDispatchAttach: (sessionId: string) => void`). Add `openPinAgents: () => void`. Then find where the `ui` object is constructed inside `commandContext` (it'll have a long list of methods including `openDispatchAttach`). Add `openPinAgents` next to it.

In App.tsx, where `<CommandPalette>` is rendered, pass `openPinAgents={openPinAgents}` as a prop.

- [ ] **Step 4: Build + smoke**

```bash
npm run build
npm run dev
```

Manually open DevTools and run `useAppStore.getState().openPinAgents()`. The modal should appear, render rows, accept Space/Enter/Esc.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app/App.tsx \
        src/renderer/src/features/command-palette/types.ts \
        src/renderer/src/features/command-palette/ui/CommandPalette.tsx
git commit -m "feat(dispatch): mount PinAgentsModal + forward openPinAgents through palette"
```

---

## Task 11: Register `pin-agents` and `unpin-agent` commands

**Files:**
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts`

- [ ] **Step 1: Add `pin-agents`**

Open `paneCommands.ts`. Find the existing `attach-detached-to-grid` command — it's the right shape (dispatch-mode-only, opens a modal). Right after it, add:

```ts
{
  id: 'pin-agents',
  title: 'Pin Agents…',
  description: '**What it does:** Opens the multi-select Pin modal to choose which **Dispatch** agents stay pinned at the top of the agent list.\n\n**Use when:** You want a few favorite agents to always be one keystroke away regardless of project or scope.\n\n**Notes:** Space toggles, Enter commits, Esc cancels. The order you Space through the rows is the order pins render in.',
  keywords: ['pin', 'pins', 'pinned', 'favorite', 'star', 'top', 'dispatch'],
  when: ({ workspace }) => Boolean(workspace.dispatchMode),
  run: ({ ui }) => ui.openPinAgents(),
},
```

- [ ] **Step 2: Add `unpin-agent`**

Below the new `pin-agents` entry:

```ts
{
  id: 'unpin-agent',
  title: 'Unpin Agent',
  description: '**What it does:** Removes the currently-focused **Dispatch** row from the Pinned section.\n\n**Use when:** You want to quickly drop a single pin without opening the Pin modal.\n\n**Notes:** Only appears when the focused dispatch row is currently pinned.',
  keywords: ['unpin', 'remove', 'pin', 'pinned', 'star'],
  when: ({ workspace }) => {
    if (!workspace.dispatchMode) return false
    const focused = workspace.dispatchMode.focusedSessionId
    if (!focused) return false
    return workspace.state.pinnedSessionIds.includes(focused)
  },
  run: ({ workspace }) => {
    const focused = workspace.dispatchMode?.focusedSessionId
    if (!focused) return
    workspace.unpinSession(focused)
  },
},
```

- [ ] **Step 3: Build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/workspace/commands/paneCommands.ts
git commit -m "feat(dispatch): pin-agents + unpin-agent commands"
```

---

## Task 12: Manual verification + open PR

- [ ] **Step 1: Full smoke run**

```bash
npm run build
npm run dev
```

In the app:
1. Enter Dispatch mode in a workspace with at least 2 tabs and 2 agents per tab.
2. Open command palette (⌘K or whatever the binding is). Type "pin". Confirm `Pin Agents…` appears in the suggestion list.
3. Run it. Modal opens. Space toggles two agents from two different tabs. Confirm `★` indicator appears next to selected rows.
4. Press Enter. Modal closes. Dispatch list now shows a new **Pinned** group at the top with both agents in the order you Space'd them. Each row has a project chip on the right.
5. Switch dispatch scope between Project and Global. Confirm: in BOTH scopes, the Pinned section is always present and shows BOTH agents (cross-project pins are scope-independent).
6. Focus a pinned row, run `Unpin Agent` from the palette. Confirm it disappears from Pinned and reappears in its original project group.
7. Kill a pinned agent (close its pane). Confirm the Pinned section auto-prunes the dead entry.
8. Reload the app (Cmd+R or full restart). Confirm pins survive — they're in `workspace.json`.

- [ ] **Step 2: Push + open PR**

```bash
gh auth status --hostname github.com  # confirm Juliusolsson05
git push -u origin <branch>
gh pr create --title "feat(dispatch): pin agents to top of dispatch list" --body "$(cat <<'EOF'
## Summary

- New `Pin Agents…` command in Dispatch mode opens a multi-select modal (Space toggles, Enter commits, Esc cancels).
- Pinned agents render in a new **Pinned** group at the top of the dispatch list, ordered by pin sequence (first you Space, first they appear).
- Pinned section is **always shown** regardless of dispatch scope — the whole point of pins is they survive the project↔global toggle. Each row carries a small project chip so cross-project pins stay disambiguable.
- New `Unpin Agent` command unpins the currently-focused pinned row for quick keyboard-driven removal.
- `pinnedSessionIds: SessionId[]` lives in `WorkspaceState` next to `detachedSessions`, persisted to `workspace.json`. Killed sessions are auto-pruned by the existing cleanup pass.

## Test plan

- [ ] `npm run build` clean
- [ ] Manual smoke per the Task 12 steps above
- [ ] Restart preserves pins
- [ ] Killing a pinned agent auto-removes it from Pinned

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Per `feedback_no_auto_merge.md`: open the PR, then stop. Wait for the user to merge.

---

## Self-Review

**Spec coverage:**
- "Multi-select modal in Dispatch": Task 8 (state flag) + Task 9 (component) + Task 11 (command). ✓
- "Space toggles, Enter accepts": Task 9 keybinds hook. ✓
- "Pinned across global scopes — the point": Task 6 (selector is NOT scope-aware) + Task 7 (modal is always rendered). ✓
- "Order you pin in is order it displays": Task 5 (`pinSession` appends to tail; `setPinnedSessionIds` preserves caller order) + Task 9 keybinds hook (`toggle` appends on add). ✓
- "Unpin command also": Task 11. ✓
- "Small labels for project grouping": Task 7 (`projectChip` prop, rendered with tabIndexLabel + tabTitle). ✓
- Persistence — not explicitly requested but obviously needed: Task 3. ✓
- Auto-prune of killed sessions — not requested but the only sane invariant: Task 4. ✓

**Placeholder scan:** None. Every code step shows the actual code; every command-line step shows the actual command + expected output.

**Type consistency:** `pinnedSessionIds: SessionId[]` is consistent across Tasks 1, 2, 3, 4, 5, 6, 9, 10. `pinSession(sessionId: SessionId): void`, `unpinSession(sessionId: SessionId): void`, `setPinnedSessionIds(ids: SessionId[]): void` consistent across Task 5 (definition) and Task 11 (consumer). `buildPinnedDispatchRows(state: WorkspaceState): DispatchAgentRow[]` consistent across Task 6 (definition) and Task 7 (consumer). `pinAgentsOpen: boolean` + `openPinAgents`/`closePinAgents` consistent across Task 8 (state) and Tasks 10–11 (consumers).

**Critical not-done thing:** This plan does NOT implement drag-reorder of pins. The "order is pin order" rule means there's no UI to reorder existing pins without unpin/re-pin. If the user wants drag-reorder later, that's a follow-up plan (introduces a fourth keybind to the modal — Cmd+Up/Down to shuffle the focused row in the selected list).
