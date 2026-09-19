import type { CommandDef } from '@renderer/features/command-palette/types'
import { status, toggle, value } from '@renderer/features/command-palette/commandState'
import {
  MAX_DISPATCH_LANES,
  MAX_DISPATCH_ROWS,
  MAX_DISPATCH_TILES,
  MIN_DISPATCH_TILES,
  normalizeGridShape,
  rowIndexForLane,
  rowStartIndex,
} from '@renderer/workspace/dispatch/gridShape'
import { resolveStrictDispatchCommandTarget } from '@renderer/workspace/dispatch/dispatchTarget'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { moveLaneSelection, moveLaneFocusWithinRow } from '@renderer/workspace/dispatch/laneKeyboard'
import type { WorkspaceState } from '@renderer/workspace/types'
import { useAppStore } from '@renderer/app-state/hooks'

// Exported by name because its admission and badge are pinned directly in
// clearLane.renderer.test.tsx — looking the def up by id inside that suite
// would pass vacuously if the id were ever renamed (find → undefined →
// `when?.()` → undefined → "passes" the not-false assertions).
//
// Clear Lane (#992 §4.4): the gentle exit. The occupant returns to the pool
// ALIVE and stays in this row's index; the lane is empty and nothing refills
// it (#681). Paired with Remove Lane below — same slot, opposite blast
// radius — and with Close Agent and Remove Lane for the destructive version
// of each half.
// The stage's keyboard grammar as commands (#992 stage 5, the #681 §7.1
// debt): ⌥↑/↓ walk the focused lane's selection through its row's index,
// ⌥←/→ move lane focus within the row. These were an unregistered inline
// branch in useKeybinds — which meant they could not be rebound, never
// appeared in the shortcuts surface, and silently swallowed Alt+Shift+Arrow
// (the branch tested `alt && !cmd`, never shift). As registered commands the
// chords are exact-match, so ⌥⇧-arrow stays the OS's word-selection.
//
// The movers live in workspace/dispatch/laneKeyboard.ts — one home for the
// grammar — and selection writes through `selectTiledLaneSession`, never the
// raw lane writer, so a hibernated agent wakes before it is placed (#690).
const laneKeyboardCommands: CommandDef[] = [
  {
    id: 'dispatch-select-previous-agent',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Select Previous Agent',
    description: '**What it does:** Moves the **focused lane**\'s selection one step UP its row\'s agent index, wrapping around.\n\n**Use when:** You are scanning agents in the lane you are in.\n\n**Notes:** Agents shown in other lanes are not skipped — selecting one mirrors it here. Hibernated agents wake on selection.',
    keywords: ['previous', 'up', 'agent', 'walk', 'index', 'lane', 'selection', 'arrows'],
    run: ({ workspace }) => moveLaneSelection(workspace, -1),
  },
  {
    id: 'dispatch-select-next-agent',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Select Next Agent',
    description: '**What it does:** Moves the **focused lane**\'s selection one step DOWN its row\'s agent index, wrapping around.\n\n**Use when:** You are scanning agents in the lane you are in.\n\n**Notes:** Agents shown in other lanes are not skipped — selecting one mirrors it here. Hibernated agents wake on selection.',
    keywords: ['next', 'down', 'agent', 'walk', 'index', 'lane', 'selection', 'arrows'],
    run: ({ workspace }) => moveLaneSelection(workspace, 1),
  },
  {
    id: 'dispatch-focus-lane-left',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Focus Lane Left',
    description: '**What it does:** Moves lane focus one lane LEFT within the focused row, stopping at the row\'s edge.\n\n**Use when:** You want to type into the lane beside this one.\n\n**Notes:** Never wraps into another row and never changes any lane\'s agent — crossing rows is what Focus Row Above/Below is for.',
    keywords: ['focus', 'left', 'lane', 'cursor', 'arrows'],
    run: ({ workspace }) => moveLaneFocusWithinRow(workspace, -1),
  },
  {
    id: 'dispatch-focus-lane-right',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Focus Lane Right',
    description: '**What it does:** Moves lane focus one lane RIGHT within the focused row, stopping at the row\'s edge.\n\n**Use when:** You want to type into the lane beside this one.\n\n**Notes:** Never wraps into another row and never changes any lane\'s agent — crossing rows is what Focus Row Above/Below is for.',
    keywords: ['focus', 'right', 'lane', 'cursor', 'arrows'],
    run: ({ workspace }) => moveLaneFocusWithinRow(workspace, 1),
  },
]

export const clearFocusedLaneCommand: CommandDef = {
  id: 'clear-focused-lane',
  category: 'layout-dispatch',
  surface: 'workspace',
  title: 'Clear Lane',
  // `getState` badges the occupant's title, because "clear" needs an object:
  // with several lanes on screen a bare "Clear Lane" sends the user to check
  // which lane is focused first. The badge is that check. The shared title
  // resolver (explicit title → cwd basename), not the raw meta.title: most
  // agents have no explicit title, and a badge that reads "undefined" is
  // worse than no badge.
  getState: ({ workspace }) => {
    const tiled = workspace.state.stage
    const sessionId = tiled.lanes[tiled.focusedLane]?.selectedSessionId
    const meta = sessionId ? workspace.state.sessions[sessionId] : undefined
    return meta ? value(sessionDisplayTitle(meta)) : null
  },
  description: '**What it does:** Empties the **focused lane**. The agent in it keeps running and stays in the index.\n\n**Use when:** You want the space back without ending the agent — the inverse of picking one into the lane.\n\n**Notes:** Nothing refills the lane. Put the agent (or another) back with one click in the row index, or ⌘1–9.',
  keywords: ['clear', 'empty', 'lane', 'unplace', 'park', 'release', 'tiled dispatch', 'stage'],
  when: ({ workspace }) => {
    const tiled = workspace.state.stage
    const sessionId = tiled.lanes[tiled.focusedLane]?.selectedSessionId
    return Boolean(sessionId && workspace.state.sessions[sessionId])
  },
  run: ({ workspace }) => {
    const tiled = workspace.state.stage
    workspace.clearTiledLane(tiled.focusedLane)
  },
}

export const layoutCommands: CommandDef[] = [
  // DELETED with the two-mode layout (#992): `dispatch-mode` (the mode
  // toggle — there is no second mode to toggle into) and `global-dispatch`
  // (Dispatch scope — per-row project binding is the only scoping
  // mechanism now). Their ids are recorded in the plan so release notes
  // can tell users their bindings moved.

  {
    id: 'tiled-dispatch',
    category: 'layout-dispatch',
    // The shape editor is the workspace's reshape surface — it opens on the
    // CURRENT stage shape. Id kept from the Grid Dispatch era so existing
    // ⌘D bindings and visibility overrides are not orphaned (#992 §5.4).
    surface: 'app',
    title: 'Stage Shape…',
    description: '**What it does:** Opens the stage shape editor — rows of lanes, one stepper per row.\n\n**Use when:** You want to reshape many lanes at once, or see the ragged-by-design shape before committing it.\n\n**Notes:** Rows are independent, so 4 lanes on top and 2 below is a normal shape. Day-to-day, **New Lane** / **New Row** / **Remove Lane** / **Remove Row** edit the shape in place.',
    keywords: ['stage shape', 'grid dispatch', 'tiled dispatch', 'lanes', 'rows', 'reshape', 'multi agent', 'parallel agents'],
    run: ({ ui }) => ui.openTiledDispatchPrompt(),
  },
  {
    id: 'new-tiled-lane',
    category: 'layout-dispatch',
    // `app`, not `workspace` (#978): New Lane is the primary incremental way
    // to grow the stage and must be reachable from every surface.
    //
    // History worth keeping: this command used to have an ENTRY path. With
    // Grid Dispatch off there was no lane to insert beside, so it entered the
    // grid at [2] — lane 0 seeded with the focused agent (#977), lane 1 the
    // new empty lane. The stage is a required field now (#992), so there is
    // always a focused lane and the command is one thing: insert to its right.
    surface: 'app',
    title: 'New Lane',
    description: '**What it does:** Inserts a new lane immediately to the **right of the focused lane**, lengthening only that row.\n\n**Use when:** You want another live agent view without reshaping the stage or disturbing the lanes around it.\n\n**Notes:** Rows are independent — this never widens any other row. The current lane stays focused and the new lane arrives empty, because adding a lane asks for space, not for a particular agent. Focus it and press ⌥↓ to put the first agent in it, or pick one from its strip.',
    keywords: ['new lane', 'add lane', 'insert lane', 'tiled dispatch', 'expand', 'right', 'grid dispatch', 'stage'],
    when: ({ workspace }) => canInsertLaneInFocusedRow(workspace.state),
    run: async ({ workspace }) => {
      // Re-checked here, not only in `when`, so a programmatic invocation that
      // never went through the palette stays inert instead of relying on the
      // reducer's refusal to be silent.
      if (!canInsertLaneInFocusedRow(workspace.state)) return
      const tiled = workspace.state.stage
      const laneIndex = tiled.focusedLane
      const sourceLane = tiled.lanes[laneIndex]
      if (!sourceLane) return
      // The raw lane id can still name a globally live but OUT-OF-SCOPE
      // session, which renders empty rather than as that agent. Use the same
      // strict visual resolver as lifecycle commands so pane feedback can only
      // target the agent the user can actually see in this focused lane.
      const sourceTarget = resolveStrictDispatchCommandTarget(workspace.state)

      const inserted = workspace.insertTiledLaneRight(laneIndex)
      if (!inserted) return

      // Pane toasts are SESSION-scoped, not lane-scoped. Reporting through the
      // still-focused source session keeps feedback at the command's point of
      // origin and avoids pretending an empty inserted lane has a runtime that
      // can own feedback. Mirrored copies may all show it by design because
      // they share that same runtime.
      if (sourceTarget?.source === 'tiled-lane' && sourceTarget.laneIndex === laneIndex) {
        workspace.showPaneToast(sourceTarget.row.sessionId, 'New lane created')
      }
    },
  },
  {
    // WHY these two exist at all: Tiled Dispatch's size is a single count, and
    // shrinking by count always drops the TAIL (`lanes.slice(0, next)`). With
    // seven lanes open and the finished agent in lane three, 7 -> 6 removes
    // lane seven. Closing that agent instead does not shrink anything either —
    // the lane empties and auto-fill re-homes another agent into it. So there
    // was no way to reclaim a slot at a position of the user's choosing.
    //
    // WHY two commands rather than one with a flag: the default is destructive,
    // and a command that sometimes ends a session and sometimes does not is
    // the kind of thing that surprises someone moving fast. The titles carry
    // the difference — `Close` is this catalog's established verb for ending a
    // session, so the destructive one leads with it.
    id: 'remove-tiled-lane',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Remove Lane',
    description: '**What it does:** Removes the **focused lane**, shrinking its row by one lane. The agent keeps running and stays in the index.\n\n**Use when:** You are done watching one agent but want the others to stay exactly where they are.\n\n**Notes:** Removing a row\'s last lane removes the row. Every lane has its own selector strip, so the lanes that shift left keep the selector they already had.',
    keywords: ['remove', 'lane', 'tile', 'tiled dispatch', 'shrink', 'slot'],
    when: ({ workspace }) => workspace.state.stage.lanes.length > MIN_DISPATCH_TILES,
    run: ({ workspace }) => {
      const tiled = workspace.state.stage
      workspace.removeTiledLane(tiled.focusedLane)
    },
  },
  clearFocusedLaneCommand,
  ...laneKeyboardCommands,
  {
    id: 'close-agent-remove-lane',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Close Agent and Remove Lane',
    description: '**What it does:** Closes the agent in the **focused lane**, then removes that lane, shrinking the layout by one.\n\n**Use when:** An agent has finished and you want it gone along with its slot.\n\n**Notes:** This ends the session. Use **Remove Lane** to reclaim the slot while leaving the agent running. Irreversible closes still confirm first, and declining leaves the layout untouched.',
    keywords: ['close', 'agent', 'remove agent', 'lane', 'tile', 'tiled dispatch', 'shrink', 'finished', 'done'],
    when: ({ workspace }) => {
      const tiled = workspace.state.stage
      if (tiled.lanes.length <= MIN_DISPATCH_TILES) return false
      // An empty lane has no agent to close, so this collapses to Remove Lane —
      // admission has to agree with what the command will do.
      //
      // Liveness, not mere presence: a lane can hold a set-but-dead id between
      // a session disappearing (killed from Agent Activity, tab closed) and the
      // clear path blanking it. Admitting on presence alone let the command
      // run, find nothing to close, and silently do neither of the two things
      // its title promises.
      const sessionId = tiled.lanes[tiled.focusedLane]?.selectedSessionId
      return Boolean(sessionId && workspace.state.sessions[sessionId])
    },
    run: async ({ workspace }) => {
      const tiled = workspace.state.stage
      const laneIndex = tiled.focusedLane
      const sessionId = tiled.lanes[laneIndex]?.selectedSessionId
      if (!sessionId) return
      // Close FIRST, and only splice if it actually happened. closeSession runs
      // its own confirmation for irreversible closes; splicing before it
      // resolves would shrink the grid while the user was still deciding, and
      // a declined confirm would leave the layout changed with the agent alive
      // — the worst of both outcomes.
      //
      // What `true` means is exactly "the session THIS lane shows was closed"
      // (#886 review round 2). It stays false when the close was declined,
      // refused (the agent changed, or a linked session is still open) or the
      // session was already gone — even if the operation closed some of its
      // linked children first, which closeSession reports in its own toast and
      // undo entry. So the lane is removed only when its agent is really gone.
      // A root close that promoted a Dispatch row into the grid still resolves
      // true; the survivor keeps its own lane, untouched here.
      const closed = await workspace.closeSession(sessionId)
      if (closed) workspace.removeTiledLane(laneIndex)
    },
  },
  {
    // WHY New Row mirrors New Lane's contract exactly: both ask for SPACE.
    // A row that arrived pre-filled would pull a whole row's worth of agents
    // out of the index unasked, which is the behavior #681 removed everywhere
    // else — the row case is just the most visible version of it.
    id: 'new-dispatch-row',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'New Row',
    description: '**What it does:** Adds a new row of lanes below the focused row, with its own agent index and project.\n\n**Use when:** You have run out of usable width — a second row shows the same agents at double the lane width.\n\n**Notes:** The new row inherits the focused row\'s lane count and arrives empty. Rows are independent afterwards: adding a lane to one never widens another.',
    keywords: ['new row', 'add row', 'grid dispatch', 'second row', 'stack', 'below', 'more agents'],
    when: ({ workspace }) => {
      const grid = normalizeGridShape(workspace.state.stage)
      return (
        grid.rows.length < MAX_DISPATCH_ROWS &&
        grid.lanes.length < MAX_DISPATCH_LANES
      )
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.stage
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      if (rowIndex < 0) return
      // Report through the still-focused source session, as New Lane does:
      // pane toasts are session-scoped, and an empty inserted row has no
      // runtime that could own the feedback.
      const source = resolveStrictDispatchCommandTarget(workspace.state)
      if (workspace.insertDispatchRowBelow(rowIndex) && source) {
        workspace.showPaneToast(source.row.sessionId, 'New row created')
      }
    },
  },
  {
    id: 'remove-dispatch-row',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Remove Row',
    description: '**What it does:** Removes the focused row and its lanes. The agents keep running and stay in the index.\n\n**Use when:** You are done with a row of agents but want the other rows exactly where they are.\n\n**Notes:** Refused on the last row — the stage always keeps at least one.',
    keywords: ['remove row', 'delete row', 'grid dispatch', 'shrink', 'fewer rows'],
    when: ({ workspace }) => normalizeGridShape(workspace.state.stage).rows.length > 1,
    run: ({ workspace }) => {
      const tiled = workspace.state.stage
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      if (rowIndex >= 0) workspace.removeDispatchRow(rowIndex)
    },
  },
  {
    // (This and the three commands after it carried `when: tiled grid is on`
    // until #992. The stage always exists, so the gate was always true and was
    // removed rather than left as a condition that reads like a real one.)
    //
    // A noun with its state in a badge, per docs/command-style.md rule 3 —
    // never "Bind Row to Project". "Any project" is a VALUE in the picker
    // rather than a separate unbind command, the same correction that made
    // Dispatch Scope name both of its ends.
    id: 'dispatch-row-project',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Row Projects…',
    description: '**What it does:** Restricts the focused row\'s agent index and lane selectors to one or more projects.\n\n**Use when:** A row is a working context that spans more than one repo — an app and the service it calls, a package and its consumer.\n\n**Notes:** The row\'s index shows one section per bound project. Binding filters, it never fills — no lane is populated, moved, or cleared. An unbound row lists every project.',
    keywords: ['row project', 'row projects', 'bind row', 'restrict row', 'per project', 'grid dispatch', 'scope row', 'multiple projects'],
    getState: ({ workspace }) => {
      const tiled = workspace.state.stage
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      const ids = rowIndex >= 0 ? grid.rows[rowIndex]?.projectTabIds : undefined
      if (!ids || ids.length === 0) return value('Any')
      if (ids.length === 1) {
        return value(workspace.state.tabs.find(tab => tab.id === ids[0])?.title ?? 'Project')
      }
      return value(`${ids.length} projects`)
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.stage
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      if (rowIndex >= 0) useAppStore.getState().openDispatchRowProjectPicker(rowIndex)
    },
  },
  {
    id: 'dispatch-row-child-cap',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Nested Agents',
    description: '**What it does:** Switches the focused row\'s index between capping a parent\'s nested children and showing all of them.\n\n**Use when:** A parent has spawned enough workers to bury every other agent in the list.\n\n**Notes:** Applies to both orchestration children and manually linked agents — Dispatch nests them identically, so the cap cannot tell them apart. Only nested children are ever hidden; top-level agents always show, because the parent is what reports. Hiding a child never renumbers anything: labels and ⌘N stay on the full canonical list.',
    keywords: ['nested', 'orchestrated', 'orchestration', 'linked', 'children', 'collapse', 'expand', 'sub agents', 'workers', 'cap'],
    getState: ({ workspace }) => {
      const tiled = workspace.state.stage
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      const capped = rowIndex >= 0 ? grid.rows[rowIndex]?.capChildren !== false : true
      return value(capped ? 'Capped' : 'All')
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.stage
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      if (rowIndex < 0) return
      workspace.setDispatchRowCapChildren(
        rowIndex,
        grid.rows[rowIndex]?.capChildren === false,
      )
    },
  },
  {
    // Row focus movement. The existing ⌥←/→ move WITHIN a row and stop at its
    // edges; wrapping would make one keystroke move focus a lane or jump it
    // across the layout depending on position — fine when looking, wrong when
    // typing fast. These are the deliberate cross-row pair.
    //
    // Registered as real commands rather than handled inline in useKeybinds
    // like the other Dispatch arrows, so they appear in Keyboard Shortcuts and
    // can be rebound. Migrating the four existing inline arrows is its own
    // issue — a rebindable-keys migration does not belong inside a layout PR.
    id: 'dispatch-focus-row-up',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Focus Row Above',
    description: '**What it does:** Moves lane focus to the row above, keeping the same column where the row is wide enough.\n\n**Use when:** You are driving a grid from the keyboard.\n\n**Notes:** Moving focus never changes any lane\'s agent.',
    keywords: ['focus row', 'row above', 'up', 'grid dispatch', 'navigate rows'],
    run: ({ workspace }) => focusAdjacentRow(workspace, -1),
  },
  {
    id: 'dispatch-focus-row-down',
    category: 'layout-dispatch',
    surface: 'workspace',
    title: 'Focus Row Below',
    description: '**What it does:** Moves lane focus to the row below, keeping the same column where the row is wide enough.\n\n**Use when:** You are driving a grid from the keyboard.\n\n**Notes:** Moving focus never changes any lane\'s agent.',
    keywords: ['focus row', 'row below', 'down', 'grid dispatch', 'navigate rows'],
    run: ({ workspace }) => focusAdjacentRow(workspace, 1),
  },
  // REMOVED: the 'toggle-dispatch-terminal' command, then its replacement
  // `settings.dispatchProjectTerminal`, and now the feature itself. The
  // opt-in auto-created companion terminal and its dedicated Dispatch side
  // column are gone; user-created terminals still work exactly as before.
  // DELETED with the tile tree (#992): normalize-layout,
  // hard-normalize-layout, rotate-layout rebalanced `tab.root` split
  // ratios, and split ratios no longer render anywhere. The stage's
  // equivalents are the lane/row weight drags and the shape editor.
  // RETIRED: `toggle-status-mode`. Status Mode is a persisted app preference
  // with no meaningful momentary scope — there is no "just for this session"
  // version of it — so it has one product home, and that home is Settings
  // (Appearance → Status Mode, backed by `showStatusMode`). A command that
  // duplicates a durable preference gives the same setting two owners and two
  // places to look when it is wrong.
  {
    // Preserve this ID so saved bindings keep opening the promoted product surface.
    id: 'toggle-performance-panel',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Performance Monitor',
    description: '**What it does:** Opens live CPU, memory, responsiveness and agent process monitoring.\n\n**Use when:** Agent Code feels slow or you want to understand resource use.\n\n**Notes:** Local baseline collection is always on; opening this view shows the existing measurements.',
    keywords: ['performance', 'stats', 'cpu', 'memory', 'panes'],
    getState: ({ flags }) => toggle(flags.performancePanelOpen),
    run: ({ ui }) => ui.togglePerformancePanel(),
  },
  {
    id: 'save-performance-report',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Save Performance Report',
    description: '**What it does:** Saves the last 15 minutes of bounded local performance history, operation timings, incidents and coverage metadata.\n\n**Use when:** You want a small report to inspect without transcript-heavy debug logs.\n\n**Notes:** Opens Performance Monitor → Recordings, where a native picker chooses the destination and the saved file can be revealed. Nothing is uploaded.',
    keywords: ['performance', 'report', 'export', 'slow', 'incident', 'local'],
    // WHY route through the monitor instead of calling the API here: the
    // palette closes before the native picker returns, so a direct call had
    // nowhere to show the saved path, a Reveal action or a write failure.
    run: ({ ui }) => ui.openPerformancePanel({ view: 'recordings', action: 'save-report' }),
  },
  {
    id: 'record-performance-trace',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Record Performance Trace',
    description: '**What it does:** Records a filtered app-wide Chromium trace for up to 30 seconds.\n\n**Use when:** The live monitor identifies a slowdown that needs deeper scheduler or rendering evidence.\n\n**Notes:** Explicit recording can contain detailed runtime data. A native picker chooses the local destination first; Recordings shows progress, Stop and the saved file.',
    keywords: ['performance', 'trace', 'profile', 'record', 'chromium', 'slow'],
    // An app-wide recording must be visibly in progress and stoppable. Opening
    // Recordings gives it the indicator and controls a background start lacked.
    run: ({ ui }) => ui.openPerformancePanel({ view: 'recordings', action: 'record-chromium' }),
  },
  {
    id: 'toggle-caffeinate',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Caffeinate',
    description: '**What it does:** Toggles a macOS `caffeinate` process so long-running agent work can prevent idle/system sleep.\n\n**Use when:** You want Agent Code to keep the machine awake while agents run.\n\n**Notes:** macOS lid-close behavior is hardware and power-state dependent; this command does not guarantee work keeps running after the lid is closed.',
    keywords: ['sleep', 'awake', 'macos', 'power', 'long running', 'idle'],
    // Unsupported is a STATUS, not a value whose text happens to read
    // "Unsupported". The old shape rendered it as an ordinary neutral label,
    // so a command that cannot work on this platform looked identical to one
    // that is merely off — and stayed fully executable.
    getState: ({ flags }) =>
      flags.caffeinateSupported
        ? toggle(flags.caffeinateActive)
        : status('unavailable', 'caffeinate is only available on macOS'),
    run: ({ ui }) => ui.toggleCaffeinate(),
  },
  // Editor commands (toggle-global-editor, quick-open, AI workspace,
  // file tree, fullscreen) moved to
  // features/global-editor/commands/globalEditorCommands.ts — the editor
  // feature owns its own palette module now (#513 isolation).
]

/**
 * Move lane focus one row up or down, preserving the column ordinal.
 *
 * Clamped to the destination row's length rather than wrapping: rows are
 * ragged, so the same column does not exist in every row, and landing on the
 * nearest real lane is more predictable than refusing the move.
 */
function focusAdjacentRow(
  workspace: Parameters<NonNullable<CommandDef['run']>>[0]['workspace'],
  delta: number,
): void {
  const tiled = workspace.state.stage
  const grid = normalizeGridShape(tiled)
  const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
  if (rowIndex < 0) return
  const targetRow = rowIndex + delta
  const target = grid.rows[targetRow]
  if (!target) return
  const column = grid.focusedLane - rowStartIndex(grid.rows, rowIndex)
  workspace.setTiledFocusedLane(
    rowStartIndex(grid.rows, targetRow) + Math.min(column, target.length - 1),
  )
}

/**
 * Whether New Lane may act on the currently focused lane.
 *
 * Shared by `when` and `run` so the palette's admission and a programmatic
 * invocation can never disagree — the duplication they had before is how a
 * cap ends up enforced in one and not the other.
 *
 * The RAW `focusedLane` must address a real lane. Normalizing first would
 * clamp a stale coordinate into a valid one and quietly insert beside a lane
 * the user is not looking at; this is the same strict-target policy
 * dispatchTarget applies to lifecycle commands, where a stale focus means
 * "no target" rather than "the nearest target".
 *
 * The cap is PER ROW plus the total ceiling. Measuring the whole lane count
 * against MAX_DISPATCH_TILES would refuse a perfectly legal lane in a short row
 * just because a different row is full.
 */
function canInsertLaneInFocusedRow(state: WorkspaceState): boolean {
  const tiled = state.stage
  if (!tiled.lanes[tiled.focusedLane]) return false
  const grid = normalizeGridShape(tiled)
  const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
  if (rowIndex < 0) return false
  return (
    (grid.rows[rowIndex]?.length ?? 0) < MAX_DISPATCH_TILES &&
    grid.lanes.length < MAX_DISPATCH_LANES
  )
}
