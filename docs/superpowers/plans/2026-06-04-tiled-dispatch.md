# Tiled Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Tiled Dispatch` command that opens a multi-lane Dispatch layout — a pinned full index lane plus N independently-switchable live agent lanes (1–10) — so several agents are visible and controllable at once.

**Architecture:** A lane array stored inside the existing `dispatchMode` workspace state (not a second tile-tree). `DispatchLayout` forks: `tiled` present → new `TiledDispatchLayout`; absent → unchanged classic layout. Each lane's agent view is a `renderWorkspaceLeaf` call — the same operation today's single-view dispatch already uses, so no session-manager changes are needed. A one-session-per-lane invariant sidesteps the only 1:1 view↔session assumption (terminal xterm attach).

**Tech Stack:** React 18, Zustand, TypeScript, Electron renderer. Existing primitives reused: `renderWorkspaceLeaf`, `useResizableSplitter` + `SplitHandle`, `buildVisibleDispatchRows`, `selectVisibleDispatchRow`.

**Testing note (project convention):** This repo's standing rule is *no new test files in feature PRs*. Verification per task is `npx tsc -p tsconfig.web.json --noEmit` (renderer typecheck) plus a final `npm run build`, then the manual smoke checklist in Task 9. Do not add `*.test.ts(x)` files.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/renderer/src/workspace/types.ts` | Lane/tiled state types; extend `DispatchModeState` (MODIFY) |
| `src/renderer/src/workspace/dispatch/tiledDispatchSelectors.ts` | Pure helpers: claimed-session set, lane resolution, sanitize/auto-fill (CREATE) |
| `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx` | The full index list, extracted from DispatchLayout so both layouts share it (CREATE — moved code) |
| `src/renderer/src/workspace/dispatch/DispatchMiniList.tsx` | Compact, header-less per-lane selector (CREATE) |
| `src/renderer/src/workspace/dispatch/TiledDispatchLayout.tsx` | The multi-lane layout + resizers (CREATE) |
| `src/renderer/src/workspace/dispatch/DispatchLayout.tsx` | Import extracted list; add `tiled` render fork (MODIFY) |
| `src/renderer/src/workspace/hook/actions/dispatch.ts` | Reducers: enter/exit/setLane/setCount/setFocusedLane/setRatios (MODIFY) |
| `src/renderer/src/workspace/hook/context.ts` + hook wiring | Expose new actions on the workspace hook (MODIFY) |
| `src/renderer/src/app-state/*` (uiShell) | Transient `tiledDispatchPromptOpen` flag + open/close (MODIFY) |
| `src/renderer/src/features/workspace/ui/TiledDispatchCountOverlay.tsx` | Numeric 1–10 prompt overlay (CREATE) |
| `src/renderer/src/app/App.tsx` | Render the count overlay (MODIFY) |
| `src/renderer/src/features/workspace/commands/layoutCommands.ts` | `tiled-dispatch` command (MODIFY) |
| `src/renderer/src/features/command-palette/types.ts` | Add `openTiledDispatchPrompt` to `ui` (MODIFY) |
| `src/renderer/src/workspace/tile-tree/useKeybinds.ts` | Lane-aware dispatch keybinds (MODIFY) |

---

### Task 1: State types

**Files:**
- Modify: `src/renderer/src/workspace/types.ts` (the `DispatchModeState` block, ~line 237)

- [ ] **Step 1: Add lane/tiled types and extend `DispatchModeState`**

Insert directly above `export type DispatchModeState`:

```ts
/**
 * One lane in a Tiled Dispatch layout. lanes[0] is always the full index
 * lane; lanes[1..] are compact mini-list + agent-view lanes.
 */
export type DispatchLane = {
  /**
   * Session shown in this lane. Undefined => empty lane (renders a
   * lane-local "select an agent" prompt). On re-entry/rehydrate a lane
   * whose session no longer exists is reset to undefined and re-filled
   * from the next unclaimed visible agent. INVARIANT: a given sessionId
   * appears in at most one lane at a time — this is what lets Tiled
   * Dispatch reuse the single-view render path with zero session-manager
   * changes (the only 1:1 view↔session assumption is terminal xterm
   * attach, which this invariant never triggers).
   */
  selectedSessionId?: SessionId
  /**
   * RESERVED for phase-2 scroll-sync (scrolling a mini-list nudges the
   * index lane to the same region). Unused in v1; declared now so adding
   * scroll-sync later does not reshape persisted state.
   */
  scrollAnchorKey?: string
}

export type TiledDispatchState = {
  /** Tile count, clamped 1..10. lanes[0] is the index lane. */
  lanes: DispatchLane[]
  /**
   * Lane index that currently owns keyboard selection (arrows / cmd+N).
   * Switching the focused lane must never change another lane's
   * selection. Defaults to 0.
   */
  focusedLane: number
  /**
   * Per-boundary split ratios (fraction given to the left side of each
   * boundary). Absent => even distribution. Same clamp discipline as the
   * grid SplitContainer.
   */
  ratios?: number[]
}
```

Then add the field to `DispatchModeState` (keep existing fields + comments):

```ts
export type DispatchModeState = {
  scope: 'project' | 'global'
  focusedSessionId?: SessionId
  /**
   * Present => render the multi-lane TiledDispatchLayout instead of the
   * classic single-agent layout. Lives inside dispatchMode (which is
   * already persisted) so lanes/focusedLane/ratios survive reloads for
   * free. Absent => classic Dispatch (unchanged).
   */
  tiled?: TiledDispatchState
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS (no new references yet).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/workspace/types.ts
git commit -m "feat(dispatch): tiled dispatch state types (#248)"
```

---

### Task 2: Pure selectors

**Files:**
- Create: `src/renderer/src/workspace/dispatch/tiledDispatchSelectors.ts`

- [ ] **Step 1: Write the module**

```ts
import type { DispatchLane, SessionId, WorkspaceState } from '@renderer/workspace/types'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'

/** Max lanes. The issue caps tiled dispatch at 10. */
export const MAX_DISPATCH_TILES = 10
export const MIN_DISPATCH_TILES = 1
export const DEFAULT_DISPATCH_TILES = 2

export function clampTileCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DISPATCH_TILES
  return Math.max(MIN_DISPATCH_TILES, Math.min(MAX_DISPATCH_TILES, Math.floor(n)))
}

/**
 * Session ids claimed by lanes OTHER than `exceptLaneIndex`. Mini-lists
 * use this to grey out / refuse agents already shown elsewhere, enforcing
 * the one-session-per-lane invariant in the UI (the reducer enforces it
 * again as the real guard).
 */
export function claimedSessionIds(
  lanes: DispatchLane[],
  exceptLaneIndex: number,
): Set<SessionId> {
  const claimed = new Set<SessionId>()
  lanes.forEach((lane, i) => {
    if (i === exceptLaneIndex) return
    if (lane.selectedSessionId) claimed.add(lane.selectedSessionId)
  })
  return claimed
}

/**
 * Build a fresh lane array of `count` lanes, auto-assigning each lane the
 * next visible agent not already claimed by an earlier lane. Used on
 * enter and on grow. Terminals are eligible (they render through
 * renderWorkspaceLeaf like agents) but the one-per-lane rule still holds.
 */
export function buildAutoLanes(
  state: WorkspaceState,
  count: number,
  preserve: DispatchLane[] = [],
): DispatchLane[] {
  const rows = buildVisibleDispatchRows(state)
  const claimed = new Set<SessionId>(
    preserve.map(l => l.selectedSessionId).filter(Boolean) as SessionId[],
  )
  const lanes: DispatchLane[] = []
  for (let i = 0; i < count; i++) {
    if (preserve[i]) {
      lanes.push(preserve[i])
      continue
    }
    const next = rows.find(
      r => !claimed.has(r.sessionId),
    )
    if (next) {
      claimed.add(next.sessionId)
      lanes.push({ selectedSessionId: next.sessionId })
    } else {
      lanes.push({})
    }
  }
  return lanes
}

/**
 * Re-entry / rehydrate sanitizer: drop lane sessions that no longer exist
 * and de-duplicate (the invariant could be violated by a hand-edited
 * workspace.json). A lane whose session is gone or duplicated is reset to
 * empty; empties are NOT auto-refilled here (the layout effect does that
 * if desired) to keep this function pure and predictable.
 */
export function sanitizeLanes(
  state: WorkspaceState,
  lanes: DispatchLane[],
): DispatchLane[] {
  const seen = new Set<SessionId>()
  return lanes.map(lane => {
    const id = lane.selectedSessionId
    if (!id) return lane
    if (state.sessions[id] === undefined || seen.has(id)) {
      return { ...lane, selectedSessionId: undefined }
    }
    seen.add(id)
    return lane
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/workspace/dispatch/tiledDispatchSelectors.ts
git commit -m "feat(dispatch): tiled dispatch pure selectors (#248)"
```

---

### Task 3: Reducers + hook wiring

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/dispatch.ts`
- Modify: any place that re-exports the dispatch action return type onto the `Workspace` hook surface (follow the existing `focusDispatchSession`/`pinSession` wiring — they are returned from `useDispatchActions` and surfaced on the workspace object; add the new ones the same way).

- [ ] **Step 1: Add reducers inside `useDispatchActions`**

Add these `useCallback`s (after `focusDispatchSession`), importing the helpers at the top:

```ts
import {
  buildAutoLanes,
  clampTileCount,
  sanitizeLanes,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
```

```ts
// Enter (or re-shape) Tiled Dispatch. Enters dispatch mode if needed,
// clears tiled-tabs, and auto-fills lanes from unclaimed visible agents
// so the user lands on a useful pre-populated layout rather than blanks.
const enterTiledDispatch = useCallback(
  async (count: number) => {
    closeNewAgentPlacement()
    setState(prev => {
      const scope = prev.dispatchMode?.scope ?? 'project'
      const lanes = buildAutoLanes(prev, clampTileCount(count))
      return {
        ...prev,
        dispatchMode: {
          scope,
          focusedSessionId: prev.dispatchMode?.focusedSessionId,
          tiled: { lanes, focusedLane: 0 },
        },
      }
    })
    setTileTabs(null)
  },
  [closeNewAgentPlacement, setState, setTileTabs],
)

// Return to classic Dispatch (single-view). Agents keep running; we only
// drop the `tiled` block. Exiting Dispatch entirely (exitDispatchMode)
// already drops it with the rest of dispatchMode.
const exitTiledDispatch = useCallback(() => {
  setState(prev => {
    if (!prev.dispatchMode?.tiled) return prev
    const { tiled, ...rest } = prev.dispatchMode
    return { ...prev, dispatchMode: { ...rest } }
  })
}, [setState])

// Assign a lane's agent. No-op if that session is already shown in
// another lane — the reducer is the real guard for the one-per-lane
// invariant (the mini-list also greys claimed rows, but multiple write
// paths can reach here).
const setTiledLaneSession = useCallback(
  (laneIndex: number, sessionId: SessionId) => {
    setState(prev => {
      const tiled = prev.dispatchMode?.tiled
      if (!tiled) return prev
      if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return prev
      const claimedElsewhere = tiled.lanes.some(
        (l, i) => i !== laneIndex && l.selectedSessionId === sessionId,
      )
      if (claimedElsewhere) return prev
      const lanes = tiled.lanes.map((l, i) =>
        i === laneIndex ? { ...l, selectedSessionId: sessionId } : l,
      )
      return {
        ...prev,
        dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, lanes } },
      }
    })
  },
  [setState],
)

// Grow (append auto-filled lanes) or shrink (drop from the right).
// Surviving lanes keep their selections; never reshuffle or respawn.
const setTiledLaneCount = useCallback(
  (count: number) => {
    setState(prev => {
      const tiled = prev.dispatchMode?.tiled
      if (!tiled) return prev
      const next = clampTileCount(count)
      if (next === tiled.lanes.length) return prev
      const lanes =
        next < tiled.lanes.length
          ? tiled.lanes.slice(0, next)
          : buildAutoLanes(prev, next, tiled.lanes)
      const focusedLane = Math.min(tiled.focusedLane, lanes.length - 1)
      // Drop ratios on count change; even distribution is the safe reset
      // and the user can re-drag. Keeping stale ratios for a different
      // boundary count would mis-size lanes.
      return {
        ...prev,
        dispatchMode: {
          ...prev.dispatchMode!,
          tiled: { lanes, focusedLane, ratios: undefined },
        },
      }
    })
  },
  [setState],
)

const setTiledFocusedLane = useCallback(
  (laneIndex: number) => {
    setState(prev => {
      const tiled = prev.dispatchMode?.tiled
      if (!tiled) return prev
      const clamped = Math.max(0, Math.min(laneIndex, tiled.lanes.length - 1))
      if (clamped === tiled.focusedLane) return prev
      return {
        ...prev,
        dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, focusedLane: clamped } },
      }
    })
  },
  [setState],
)

const setTiledRatios = useCallback(
  (ratios: number[]) => {
    setState(prev => {
      const tiled = prev.dispatchMode?.tiled
      if (!tiled) return prev
      return {
        ...prev,
        dispatchMode: { ...prev.dispatchMode!, tiled: { ...tiled, ratios } },
      }
    })
  },
  [setState],
)
```

- [ ] **Step 2: Add all six to the hook's return object and its declared return type**

In the `useDispatchActions` return type signature and the final `return { … }`, add:
`enterTiledDispatch`, `exitTiledDispatch`, `setTiledLaneSession`, `setTiledLaneCount`, `setTiledFocusedLane`, `setTiledRatios`. Then ensure they reach the `Workspace` object the same way `focusDispatchSession`/`pinSession` do (search for `focusDispatchSession` across `hook/` to find every spot it's threaded — replicate for the new actions). Also add a `sanitizeLanes` call to the rehydrate path if dispatch state is rehydrated there; if rehydrate doesn't already special-case `dispatchMode`, leave it (the layout effect in Task 6 sanitizes at render).

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/hook
git commit -m "feat(dispatch): tiled dispatch reducers + hook wiring (#248)"
```

---

### Task 4: Extract `DispatchAgentList` for reuse

**Files:**
- Create: `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`
- Modify: `src/renderer/src/workspace/dispatch/DispatchLayout.tsx`

**Why:** `DispatchLayout.tsx` currently defines `DispatchAgentList`, `DispatchAgentListRow`, `DispatchEmpty`, and helpers privately. The tiled layout needs the same full index. Extracting them into a shared module is the clean move (the file has grown to do two jobs). Do a pure move — no behavior change.

- [ ] **Step 1: Move `DispatchAgentList`, `DispatchAgentListRow`, `DispatchEmpty`, and any private helpers they use (`latestPromptTitleCache`, `DispatchAgentActivity` type, prompt/title helpers, badge logic) into the new file. Export `DispatchAgentList` and `DispatchEmpty`.** Keep all existing WHY comments verbatim. Import shared selector/types as the original did.

- [ ] **Step 2: In `DispatchLayout.tsx`, delete the moved definitions and import them:**

```ts
import { DispatchAgentList, DispatchEmpty } from '@renderer/workspace/dispatch/DispatchAgentList'
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/dispatch
git commit -m "refactor(dispatch): extract DispatchAgentList into shared module (#248)"
```

---

### Task 5: `DispatchMiniList`

**Files:**
- Create: `src/renderer/src/workspace/dispatch/DispatchMiniList.tsx`

**Responsibility:** A dense, header-less per-lane selector. Reuses `buildVisibleDispatchRows(state)` for the row source (single source of truth), shows just `label` + `title` + a small activity dot, highlights this lane's selection, and greys out rows whose `sessionId` is in `claimedSessionIds(lanes, laneIndex)`.

- [ ] **Step 1: Write the component**

Props: `{ rows: DispatchAgentRow[]; selectedSessionId?: SessionId; claimed: Set<SessionId>; focused: boolean; onSelect: (row: DispatchAgentRow) => void }`. Render a scrollable column of buttons. A claimed row is `disabled` + dimmed (title attr "shown in another lane"). The selected row gets the active highlight (reuse the `data-dispatch-active` styling convention from `DispatchAgentList`). No section headers, no worktree/provider chips — that's the point of "compact". Keep it a `memo`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/workspace/dispatch/DispatchMiniList.tsx
git commit -m "feat(dispatch): compact per-lane mini list (#248)"
```

---

### Task 6: `TiledDispatchLayout` + render fork

**Files:**
- Create: `src/renderer/src/workspace/dispatch/TiledDispatchLayout.tsx`
- Modify: `src/renderer/src/workspace/dispatch/DispatchLayout.tsx` (add fork at top of component body)

- [ ] **Step 1: Add the fork in `DispatchLayout`** (immediately after the `const` that reads `workspace.state`, before building groups):

```tsx
if (workspace.state.dispatchMode?.tiled) {
  return (
    <TiledDispatchLayout
      workspace={workspace}
      showStatusMode={showStatusMode}
      showWorktreeBadges={showWorktreeBadges}
    />
  )
}
```

- [ ] **Step 2: Write `TiledDispatchLayout`.** Structure:

- Read `tiled = workspace.state.dispatchMode!.tiled!`, `rows = buildVisibleDispatchRows(state)` (memoized on `state`).
- A `useEffect` that calls `sanitizeLanes` + auto-refill: if any lane's `selectedSessionId` is stale or empty and an unclaimed agent exists, dispatch `setTiledLaneSession`. Guard so it only fires when something actually changes (compare against current lanes) to avoid render loops.
- Render a flex row. **Lane 0:** `<DispatchAgentList … activeSessionId={lane0.selectedSessionId} focusSessionInTab={(tabId, sid) => workspace.setTiledLaneSession(0, sid)} />` at a width from `ratios[0]` (default `1/N`), wrapped so clicking the focused-lane region also calls `setTiledFocusedLane(0)`. To its right, lane 0's agent view via `renderWorkspaceLeaf(id, id, workspace, tabId, showStatusMode, showWorktreeBadges, () => workspace.setTiledFocusedLane(0))` (resolve `tabId` from the row whose `sessionId === id`, falling back to `activeTabId`).
- **Lanes 1..N-1:** for each, `[DispatchMiniList][agent view]`. Mini-list `onSelect={row => { workspace.setTiledLaneSession(i, row.sessionId); workspace.setTiledFocusedLane(i) }}`, `claimed={claimedSessionIds(tiled.lanes, i)}`, `focused={tiled.focusedLane === i}`. Agent view same `renderWorkspaceLeaf` pattern; empty lane → `<DispatchEmpty message="select an agent" />`.
- **Boundaries:** between each top-level lane, a `SplitHandle` driven by a `useResizableSplitter` instance whose `onDrag` computes the fraction against the layout row's `getBoundingClientRect()` and writes `setTiledRatios(...)`. (For v1 you may implement a single shared ratios array updated per boundary index; mirror the math in `DispatchLayout`'s existing `listSplitter`.)
- **Overflow:** wrap lane 0 in a `flex-shrink-0` fixed-width container (its ratio width) and put lanes 1..N-1 in a sibling `flex-1 min-w-0 overflow-x-auto` strip so the index stays readable and the lane strip is what compresses/scrolls at high counts.
- **Focused-lane affordance:** add a subtle ring/border class to the focused lane's wrapper (reuse the pane-focused border token used by `TileLeaf`).

- [ ] **Step 3: Typecheck + a dev build sanity**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/dispatch
git commit -m "feat(dispatch): TiledDispatchLayout multi-lane view (#248)"
```

---

### Task 7: Command + count overlay

**Files:**
- Create: `src/renderer/src/features/workspace/ui/TiledDispatchCountOverlay.tsx`
- Modify: `src/renderer/src/app/App.tsx` (render the overlay)
- Modify: uiShell store under `src/renderer/src/app-state/` (add `tiledDispatchPromptOpen` + `openTiledDispatchPrompt`/`closeTiledDispatchPrompt`) — follow the existing transient-flag pattern in that store
- Modify: `src/renderer/src/features/command-palette/types.ts` (`ui.openTiledDispatchPrompt: () => void`) and wherever the `ui` object is constructed (wire it to the uiShell action)
- Modify: `src/renderer/src/features/workspace/commands/layoutCommands.ts` (new command)

**Why an overlay, not a palette mode:** the palette's `PaletteMode` union + `Props` is a large prop-drilled state machine; adding a numeric prompt there is more invasive than a small self-contained overlay. This mirrors the existing `NewAgentPlacementOverlay`.

- [ ] **Step 1: uiShell flag** — add `tiledDispatchPromptOpen: boolean` (default false) and the two actions to the uiShell store.

- [ ] **Step 2: Overlay component** — a centered modal: a label "How many dispatch tiles?", a number input (min 1, max 10, default = previous tiled lane count if present else 2), Enter/confirm and Esc/cancel. On confirm: `workspace.enterTiledDispatch(clampTileCount(value))` (or `setTiledLaneCount` if already tiled), then `closeTiledDispatchPrompt()`. Do not use `window.prompt`/`confirm` (Electron dialog guidance). Input is clamped, never errors.

```tsx
// key handlers
onKeyDown={e => {
  if (e.key === 'Enter') { commit(); }
  else if (e.key === 'Escape') { close(); }
}}
```

- [ ] **Step 3: Render in App.tsx** — `{ui.tiledDispatchPromptOpen && <TiledDispatchCountOverlay workspace={workspace} onClose={ui.closeTiledDispatchPrompt} />}` near the other overlays.

- [ ] **Step 4: Command** — add to `layoutCommands`:

```ts
{
  id: 'tiled-dispatch',
  surface: 'app',
  title: 'Tiled Dispatch',
  description: '**What it does:** Opens a multi-lane Dispatch layout — a full agent index plus several live agent lanes side by side.\n\n**Use when:** You want to watch and drive multiple agents at once.\n\n**Notes:** Prompts for a tile count (1–10). The leftmost lane is the full index; each other lane has its own compact selector. Re-run to change the tile count.',
  keywords: ['tiled dispatch', 'multi agent', 'lanes', 'split dispatch', 'cockpit', 'parallel agents'],
  run: ({ ui }) => ui.openTiledDispatchPrompt(),
},
```

- [ ] **Step 5: Add `enterTiledDispatch`/`setTiledLaneCount` to the command/overlay-visible workspace surface** if not already (Task 3 exposed them on the workspace hook; the overlay takes `workspace` directly, so this is just confirming the type).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src
git commit -m "feat(dispatch): Tiled Dispatch command + count overlay (#248)"
```

---

### Task 8: Lane-aware keybinds

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/useKeybinds.ts` (the dispatch keybind block, ~lines 424–505 and the `moveDispatchSelection` helper ~727–753)

- [ ] **Step 1: When `workspace.state.dispatchMode?.tiled` is present, retarget dispatch selection to the focused lane.**

- Arrow Up/Down + vim j/k: compute next row in `buildVisibleDispatchRows`, then `workspace.setTiledLaneSession(focusedLane, nextRow.sessionId)` (skip rows claimed by other lanes when stepping). When not tiled, keep the existing `moveDispatchSelection` behavior.
- `cmd+N` (single + multi-digit): resolve the Nth visible row exactly as today, then `setTiledLaneSession(focusedLane, row.sessionId)` instead of `focusDispatchRowByIndex`.
- Lane switch: bind Arrow Left / Arrow Right (and `[` / `]`) to `setTiledFocusedLane(focusedLane ∓ 1)` (clamped). These must NOT change any lane's selection.

Keep all branches guarded by `dispatchMode?.tiled` so classic dispatch keybinds are byte-for-byte unchanged when not tiled.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/useKeybinds.ts
git commit -m "feat(dispatch): lane-aware keybinds for tiled dispatch (#248)"
```

---

### Task 9: Full build + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + build**

Run: `npx tsc -p tsconfig.web.json --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 2: Manual smoke (launch `npm run dev`)** — verify, with 2+ agents running:
  1. `Tiled Dispatch` command prompts for a count; entering 3 opens a 3-lane layout with the full index pinned left.
  2. Each lane shows a different agent; mini-lists grey out agents shown in other lanes.
  3. Switching a lane's agent does NOT respawn (watch the agent process / no "starting" flash on others).
  4. Arrows/cmd+N change only the focused lane's selection; Left/Right switch focused lane without changing selections.
  5. Drag lane boundaries — widths persist.
  6. Toggle `Dispatch Mode` off and on — agents survive; tiled view restores from persisted state.
  7. Reload the app — lanes, focused lane, and ratios persist; a since-killed agent's lane falls back to another agent (no blank-that-resolves-to-nothing).

- [ ] **Step 3: Commit any fixups found during smoke**, then proceed to PR.

---

## Self-Review

- **Spec coverage:** command + 1–10 prompt (T7) ✓; pinned full index lane (T6) ✓; compact mini-lists per lane (T5/T6) ✓; independent per-lane agent (T3/T6) ✓; no respawn / no kill on exit (architecture — reuses `renderWorkspaceLeaf`, T6) ✓; persist across reload (state in `dispatchMode`, T1) ✓; per-lane memory across exit/re-entry + stale-drop (T2 sanitize, T6 effect) ✓; resizable widths (T6) ✓; sticky index + overflow strip (T6) ✓; preserve selections on count change (T3 `setTiledLaneCount`) ✓; scroll-sync explicitly deferred (reserved `scrollAnchorKey`, T1) ✓; lane-aware keyboard (T8) ✓.
- **Placeholder scan:** no TBD/TODO; component-heavy tasks (T5/T6/T7) give structure + props + the load-bearing snippets rather than full final JSX — acceptable for the executor (self, this session) but flagged as the least-prescriptive tasks.
- **Type consistency:** action names (`enterTiledDispatch`, `exitTiledDispatch`, `setTiledLaneSession`, `setTiledLaneCount`, `setTiledFocusedLane`, `setTiledRatios`), `DispatchLane.selectedSessionId`, `TiledDispatchState.{lanes,focusedLane,ratios}`, and `claimTileCount`→`clampTileCount` are consistent across T1–T8. ✓
