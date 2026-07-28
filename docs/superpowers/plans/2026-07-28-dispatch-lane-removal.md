# Dispatch Lane Removal Implementation Plan

> **Status:** PROPOSED — awaiting review. Ships on `feat/dispatch-lane-removal`.

**Goal:** Let a user remove a *specific* lane from Tiled Dispatch, instead of only being able to shrink the grid from the tail.

---

## The problem

Tiled Dispatch's lane count is a single number, and shrinking it always drops the **tail**:

```ts
// actions/dispatch.ts — setTiledLaneCount
const lanes = next < tiled.lanes.length
  ? tiled.lanes.slice(0, next)          // <- always the last lanes
  : buildAutoLanes(prev, next, tiled.lanes)
```

So with 7 lanes open and the agent in lane 3 finished, going 7 → 6 removes lane **7**. The user then has to re-select several lanes by hand to get back to the arrangement they wanted.

**The obvious workaround does not work either.** Closing the agent in lane 3 does not shrink the grid: `clearTiledLaneSessions` sets that lane's `selectedSessionId` to undefined, and `buildAutoLanes`' auto-fill re-homes another agent into the now-empty lane. Count stays 7.

**Net: there is currently no way to shrink the tiled grid at a position of the user's choosing.** That is the gap.

---

## Two commands, not one

The product default is *remove the lane and close the agent*. But a command that sometimes destroys a session and sometimes does not is exactly the kind of thing that surprises someone at speed, so the destructive and non-destructive behaviours are separate commands with separate names.

| | Destructive (the default) | Non-destructive |
|---|---|---|
| id | `close-agent-remove-lane` | `remove-tiled-lane` |
| title | **Close Agent and Remove Lane** | **Remove Lane** |
| agent | closed via `workspace.closeSession` | keeps running, stays in the index |
| lane | spliced out, count −1 | spliced out, count −1 |

### Why these names

- **The destructive one leads with the destruction.** `Close` is already this repo's verb for ending a session (`Close Focused Session`, `Close Tab`, `Close Old Agents`), so a title that starts with it is legible at a glance. Putting `Remove Lane` first would bury the irreversible half.
- **`Remove Agent` was rejected outright.** It reads non-destructive and is not — the worst possible name for the default.
- **`Kill Lane` was rejected**: `kill` is reserved in this catalog for buried sessions (`Kill Buried Session…`).
- **The safe command gets the shorter title**, because it is the one a user runs casually.
- Both are imperative one-shot verbs per `docs/command-style.md` rule 4, and neither takes further input, so neither carries an ellipsis (rule 8).

---

## Design decisions

### D1 — One state action, two callers

`removeTiledLane(laneIndex)` lands in `actions/dispatch.ts` beside `setTiledLaneCount`, which it mirrors. The destructive command is that action **plus** a `closeSession` call; it is not a second code path through the lane state. Two lane-splicing implementations would drift.

### D2 — Order: close first, then splice

`closeSession` is async and runs its own confirmation dialog for irreversible closes. Splicing the lane first would leave the grid already shrunk while the user is still deciding, and a cancelled confirm would leave the layout changed with the agent alive — the worst of both. So: await the close, and only splice if it actually happened.

**This means `closeSession` must report whether it closed.** It currently returns `Promise<void>`. Widening it to return a boolean is in scope; the alternative — re-reading state to infer whether the session survived — is a guess.

### D3 — Refuse at the minimum lane count

`when` requires `lanes.length > MIN_DISPATCH_TILES`. Removing the last lane would leave a tiled layout with nothing in it; the command for that is **Dispatch Mode** (exit tiled), and offering a lane-removal that silently becomes a mode-exit would be two different actions wearing one name.

### D4 — Reset `ratios`, matching `setTiledLaneCount`

Stored lane-boundary ratios are positional. Removing a lane invalidates them, so `ratios: undefined` and let the layout recompute — exactly what `setTiledLaneCount` already does on any count change.

### D5 — Clamp `focusedLane`

Removing the focused lane leaves `focusedLane` pointing past the end when it was the last one. Clamp to `lanes.length - 1`, the same clamp `setTiledLaneCount` applies.

### D6 — Lane 0 is a real lane, and removing it has a visible consequence

Lane 0 is not the index sidebar — the index is a separate column. Lane 0 is an ordinary agent lane that simply has no mini-list of its own, because it is selected from the full index (`TiledDispatchLayout.tsx`: `{laneIndex > 0 && <DispatchMiniList …>}`).

So removing lane 0 promotes lane 1 into position 0, and that lane **loses its own selector**. Mechanically fine, and no special-casing is warranted — but the command descriptions should not pretend the grid is homogeneous.

### D7 — Surface is `dispatch`

Both commands are meaningless outside Tiled Dispatch. `surface: 'dispatch'` per `docs/command-style.md` rules 10–11.

---

## Files

| File | Change |
|---|---|
| `src/renderer/src/workspace/hook/actions/dispatch.ts` | new `removeTiledLane(laneIndex)`; add to the returned object and its type |
| `src/renderer/src/workspace/hook/actions/pane.ts` | `closeSession` returns `Promise<boolean>` |
| `src/renderer/src/workspace/hook/index.ts` | expose `removeTiledLane` |
| `src/renderer/src/features/workspace/commands/layoutCommands.ts` | the two commands |
| `src/renderer/src/features/command-palette/catalog.test.ts` | snapshot + counts 102 → 104 |
| `src/renderer/src/workspace/dispatch/tiledLaneRemoval.test.ts` | **new** — unit tests for the splice/clamp logic |

---

## Tasks

### Task 1: `removeTiledLane` state action

- [ ] **Step 1:** In `actions/dispatch.ts`, beside `setTiledLaneCount`:

```ts
/**
 * Remove ONE lane by index, shrinking the grid by one.
 *
 * WHY this exists next to setTiledLaneCount rather than being expressible
 * through it: that action only takes a COUNT, and shrinking by count always
 * drops the tail (`lanes.slice(0, next)`). With seven lanes open and the
 * finished agent in lane three, 7 -> 6 removes lane seven and leaves the user
 * re-selecting the rest by hand.
 *
 * Closing the agent instead does not shrink anything either: the lane empties
 * and buildAutoLanes' auto-fill re-homes another agent into it. So before this
 * action there was no way at all to shrink the tiled grid at a chosen position.
 */
const removeTiledLane = useCallback(
  (laneIndex: number) => {
    setState(prev => {
      const tiled = prev.dispatchMode?.tiled
      if (!tiled) return prev
      // Refuse below the floor. Emptying the layout is Dispatch Mode's job;
      // a lane-removal that silently becomes a mode-exit is two actions
      // sharing one name.
      if (tiled.lanes.length <= MIN_DISPATCH_TILES) return prev
      if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return prev
      const lanes = tiled.lanes.filter((_, i) => i !== laneIndex)
      return {
        ...prev,
        dispatchMode: {
          ...prev.dispatchMode!,
          tiled: {
            lanes,
            // Same clamp setTiledLaneCount applies: removing the last lane
            // leaves focusedLane past the end.
            focusedLane: Math.min(tiled.focusedLane, lanes.length - 1),
            // Ratios are positional, so removing a lane invalidates them.
            ratios: undefined,
          },
        },
      }
    })
  },
  [setState],
)
```

- [ ] **Step 2:** Add `removeTiledLane: (laneIndex: number) => void` to the hook's return type and the returned object; expose it in `workspace/hook/index.ts`.

- [ ] **Step 3:** `npx tsc -b --pretty false` → exit 0.

- [ ] **Step 4:** Commit.

### Task 2: `closeSession` reports whether it closed

- [ ] **Step 1:** Widen `closeSession` in `actions/pane.ts` from `Promise<void>` to `Promise<boolean>` — `true` when the session was closed, `false` when it did not exist or the user cancelled the confirmation. Update the declared signature and every `return` in that function.

- [ ] **Step 2:** Existing callers ignore the value, so no call-site changes are required. Verify with `tsc`.

- [ ] **Step 3:** Commit.

### Task 3: The two commands

- [ ] **Step 1:** In `layoutCommands.ts`, after `tiled-dispatch`:

```ts
{
  id: 'remove-tiled-lane',
  category: 'layout-dispatch',
  surface: 'dispatch',
  title: 'Remove Lane',
  description: '**What it does:** Removes the **focused lane** from Tiled Dispatch and shrinks the grid by one. The agent keeps running and stays in the index.\n\n**Use when:** You are done watching one agent but want to keep the others exactly where they are.\n\n**Notes:** Changing the tile count instead always drops the LAST lane. Removing the leftmost lane promotes the next one into its place, where it is selected from the full index rather than its own compact selector.',
  keywords: ['remove', 'lane', 'tile', 'tiled dispatch', 'shrink', 'close lane'],
  when: ({ workspace }) => {
    const tiled = workspace.state.dispatchMode?.tiled
    return Boolean(tiled && tiled.lanes.length > MIN_DISPATCH_TILES)
  },
  run: ({ workspace }) => {
    const tiled = workspace.state.dispatchMode?.tiled
    if (!tiled) return
    workspace.removeTiledLane(tiled.focusedLane)
  },
},
{
  id: 'close-agent-remove-lane',
  category: 'layout-dispatch',
  surface: 'dispatch',
  title: 'Close Agent and Remove Lane',
  description: '**What it does:** Closes the agent in the **focused lane**, then removes that lane and shrinks the grid by one.\n\n**Use when:** An agent has finished and you want it gone along with its slot.\n\n**Notes:** This ends the session. Use **Remove Lane** to reclaim the slot while leaving the agent running. Irreversible closes still confirm first, and cancelling leaves the grid untouched.',
  keywords: ['close', 'agent', 'lane', 'tile', 'tiled dispatch', 'shrink', 'done'],
  when: ({ workspace }) => {
    const tiled = workspace.state.dispatchMode?.tiled
    if (!tiled || tiled.lanes.length <= MIN_DISPATCH_TILES) return false
    return Boolean(tiled.lanes[tiled.focusedLane]?.selectedSessionId)
  },
  run: async ({ workspace }) => {
    const tiled = workspace.state.dispatchMode?.tiled
    if (!tiled) return
    const laneIndex = tiled.focusedLane
    const sessionId = tiled.lanes[laneIndex]?.selectedSessionId
    if (!sessionId) return
    // Close FIRST. closeSession runs its own confirmation for irreversible
    // closes; splicing before it resolves would shrink the grid while the
    // user was still deciding, and a cancelled confirm would leave the
    // layout changed with the agent still alive.
    const closed = await workspace.closeSession(sessionId)
    if (closed) workspace.removeTiledLane(laneIndex)
  },
},
```

- [ ] **Step 2:** Import `MIN_DISPATCH_TILES` from `tiledDispatchSelectors`.

- [ ] **Step 3:** Update `catalog.test.ts` — ordered snapshot (both ids after `tiled-dispatch`), `toHaveLength(104)`, the two test names, and **both** arithmetic assertions. Note the second one: its subtracted term is the count of approved additions and its expected value is the pre-governance baseline of 102, so raise the **subtrahend** to 7, never the right-hand side.

- [ ] **Step 4:** `npm run check:keybindings` → OK.

- [ ] **Step 5:** Commit.

### Task 4: Tests

Tests are welcome in this repo (`docs/testing/standard.md`); the splice/clamp logic is pure state and worth pinning.

- [ ] **Step 1:** Extract the reducer body into a pure exported helper in `tiledDispatchSelectors.ts` so it can be tested without a hook:

```ts
export function removeLaneFromTiled(
  tiled: TiledDispatchState,
  laneIndex: number,
): TiledDispatchState | null   // null = refused
```

Have `removeTiledLane` call it.

- [ ] **Step 2:** `tiledLaneRemoval.test.ts` covering:
  - removing a middle lane keeps the lanes either side, in order
  - removing the focused lane clamps `focusedLane` into range
  - removing a lane before the focused one keeps the same lane focused
  - refuses at `MIN_DISPATCH_TILES`
  - refuses an out-of-range index
  - always clears `ratios`

- [ ] **Step 3:** `NODE_ENV=test npx vitest run` → all green.

- [ ] **Step 4:** Commit.

### Task 5: Full gate

- [ ] `npx tsc -b --pretty false` → exit 0
- [ ] `NODE_ENV=test npx vitest run` → green
- [ ] `npm run check:keybindings` → OK
- [ ] `npm run test:contract` → satisfied

---

## Self-review

**Covers the reported problem:** yes — the user can now remove lane 3 specifically, in both the keep-the-agent and close-the-agent flavours.

**Type consistency:** `removeTiledLane(laneIndex: number) => void` produced in Task 1, consumed in Task 3. `closeSession` widened in Task 2, consumed in Task 3. `removeLaneFromTiled` produced in Task 4 Step 1, consumed by Task 1's action.

**Known limitation, recorded not fixed:** both commands act on the **focused** lane only. Removing an arbitrary lane by pointer — a small "×" on each lane header — is the natural mouse-first follow-up and is deliberately out of scope here.
