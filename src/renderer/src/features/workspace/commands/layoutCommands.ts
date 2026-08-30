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
import type { WorkspaceState } from '@renderer/workspace/types'
import { useAppStore } from '@renderer/app-state/hooks'

export const layoutCommands: CommandDef[] = [
  {
    id: 'dispatch-mode',
    category: 'layout-dispatch',
    // `app`, not `dispatch`: this is the toggle that ENTERS and EXITS
    // Dispatch, so it must be visible in both modes — surface-gating it
    // to `dispatch` would make it impossible to turn Dispatch on.
    surface: 'app',
    title: 'Dispatch Mode',
    description: '**What it does:** Toggles the **Dispatch** command-center layout.\n\n**Use when:** You want to scan and command agents from a compact list.\n\n**Notes:** Shows the selected agent alongside the agent list. Run again to return to the normal grid.',
    keywords: ['agent list', 'focused agent', 'command center', 'exit dispatch', 'grid mode', 'normal layout'],
    // An ENUM, not a boolean: Dispatch is off, project-scoped, or global. The
    // old shape rendered "Global"/"Project"/"Off" through the same chip as
    // every on/off toggle, so a scope read as an enabled state.
    getState: ({ flags }) =>
      flags.dispatchModeEnabled
        ? value(flags.globalDispatchEnabled ? 'Global' : 'Project')
        : toggle(false),
    run: async ({ ui, flags }) => {
      if (flags.dispatchModeEnabled) {
        ui.exitDispatchMode()
        return
      }
      await ui.enterDispatchMode()
    },
  },
  {
    id: 'global-dispatch',
    category: 'layout-dispatch',
    // `dispatch` surface replaces the old `when: dispatchModeEnabled`
    // guard — the registry's surface gate already hides this whenever
    // Dispatch is off, so the explicit `when` was redundant.
    surface: 'dispatch',
    title: 'Dispatch Scope',
    description: '**What it does:** Switches **Dispatch** between project scope and all-tabs scope.\n\n**Use when:** You want one command center for agents across every tab.\n\n**Notes:** Only appears while **Dispatch Mode** is enabled.',
    keywords: ['dispatch all tabs', 'agent list', 'global dispatch'],
    // A SCOPE, not a boolean. "Global Dispatch: On" told the user nothing
    // about what Off meant — the alternative is Project scope, not "no
    // dispatch". Naming both ends is the whole correction.
    getState: ({ flags }) => value(flags.globalDispatchEnabled ? 'Global' : 'Project'),
    run: async ({ ui }) => {
      await ui.enterGlobalDispatch()
    },
  },
  {
    id: 'tiled-dispatch',
    category: 'layout-dispatch',
    // `app`, like the Dispatch toggle: Tiled Dispatch enters (and is the
    // adjust-count path for) the multi-lane Dispatch layout, so it should be
    // reachable from the grid as well as from Dispatch.
    surface: 'app',
    title: 'Grid Dispatch',
    description: '**What it does:** Opens a multi-row, multi-lane **Dispatch** layout. Each row is a complete dispatch view with its own agent index, project, and lanes.\n\n**Use when:** You want to watch and drive many agents at once, or several projects side by side.\n\n**Notes:** Opens a shape editor — set a lane count per row. Rows are independent, so 4 lanes on top and 2 below is a normal shape. Re-run to reshape; existing lane selections are preserved. Return to the normal grid with **Dispatch Mode**.',
    keywords: ['grid dispatch', 'tiled dispatch', 'multi agent', 'lanes', 'rows', 'split dispatch', 'cockpit', 'parallel agents', 'grid of agents'],
    run: ({ ui }) => ui.openTiledDispatchPrompt(),
  },
  {
    id: 'new-tiled-lane',
    category: 'layout-dispatch',
    surface: 'dispatch',
    title: 'New Lane',
    description: '**What it does:** Inserts a new lane immediately to the **right of the focused lane**, lengthening only that row.\n\n**Use when:** You want another live agent view without reshaping the grid or disturbing the lanes around it.\n\n**Notes:** Rows are independent — this never widens any other row. The current lane stays focused and the new lane arrives empty, because adding a lane asks for space, not for a particular agent. Focus it and press ⌥↓ to put the first agent in it, or pick one from its strip.',
    keywords: ['new lane', 'add lane', 'insert lane', 'tiled dispatch', 'expand', 'right'],
    when: ({ workspace }) => canInsertLaneInFocusedRow(workspace.state),
    run: ({ workspace }) => {
      // Re-checked here, not only in `when`, so a programmatic invocation that
      // never went through the palette stays inert instead of relying on the
      // reducer's refusal to be silent.
      if (!canInsertLaneInFocusedRow(workspace.state)) return
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return
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
    surface: 'dispatch',
    title: 'Remove Lane',
    description: '**What it does:** Removes the **focused lane** from Tiled Dispatch, shrinking the layout by one lane. The agent keeps running and stays in the index.\n\n**Use when:** You are done watching one agent but want the others to stay exactly where they are.\n\n**Notes:** Removing a row\'s last lane removes the row. Every lane has its own selector strip, so the lanes that shift left keep the selector they already had.',
    keywords: ['remove', 'lane', 'tile', 'tiled dispatch', 'shrink', 'slot'],
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
    description: '**What it does:** Closes the agent in the **focused lane**, then removes that lane, shrinking the layout by one.\n\n**Use when:** An agent has finished and you want it gone along with its slot.\n\n**Notes:** This ends the session. Use **Remove Lane** to reclaim the slot while leaving the agent running. Irreversible closes still confirm first, and declining leaves the layout untouched.',
    keywords: ['close', 'agent', 'remove agent', 'lane', 'tile', 'tiled dispatch', 'shrink', 'finished', 'done'],
    when: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled || tiled.lanes.length <= MIN_DISPATCH_TILES) return false
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
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return
      const laneIndex = tiled.focusedLane
      const sessionId = tiled.lanes[laneIndex]?.selectedSessionId
      if (!sessionId) return
      // Close FIRST, and only splice if it actually happened. closeSession runs
      // its own confirmation for irreversible closes; splicing before it
      // resolves would shrink the grid while the user was still deciding, and
      // a declined confirm would leave the layout changed with the agent alive
      // — the worst of both outcomes.
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
    surface: 'dispatch',
    title: 'New Row',
    description: '**What it does:** Adds a new row of lanes below the focused row, with its own agent index and project.\n\n**Use when:** You have run out of usable width — a second row shows the same agents at double the lane width.\n\n**Notes:** The new row inherits the focused row\'s lane count and arrives empty. Rows are independent afterwards: adding a lane to one never widens another.',
    keywords: ['new row', 'add row', 'grid dispatch', 'second row', 'stack', 'below', 'more agents'],
    when: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return false
      const grid = normalizeGridShape(tiled)
      return (
        grid.rows.length < MAX_DISPATCH_ROWS &&
        grid.lanes.length < MAX_DISPATCH_LANES
      )
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return
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
    surface: 'dispatch',
    title: 'Remove Row',
    description: '**What it does:** Removes the focused row and its lanes. The agents keep running and stay in the index.\n\n**Use when:** You are done with a row of agents but want the other rows exactly where they are.\n\n**Notes:** Refused on the last row — emptying the layout is **Dispatch Mode**\'s job.',
    keywords: ['remove row', 'delete row', 'grid dispatch', 'shrink', 'fewer rows'],
    when: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      return Boolean(tiled && normalizeGridShape(tiled).rows.length > 1)
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      if (rowIndex >= 0) workspace.removeDispatchRow(rowIndex)
    },
  },
  {
    // A noun with its state in a badge, per docs/command-style.md rule 3 —
    // never "Bind Row to Project". "Any project" is a VALUE in the picker
    // rather than a separate unbind command, the same correction that made
    // Dispatch Scope name both of its ends.
    id: 'dispatch-row-project',
    category: 'layout-dispatch',
    surface: 'dispatch',
    title: 'Row Projects…',
    description: '**What it does:** Restricts the focused row\'s agent index and lane selectors to one or more projects.\n\n**Use when:** A row is a working context that spans more than one repo — an app and the service it calls, a package and its consumer.\n\n**Notes:** The row\'s index shows one section per bound project. Binding filters, it never fills — no lane is populated, moved, or cleared. Dispatch scope is promoted to global, because a project-scoped row set is built from the active tab alone.',
    keywords: ['row project', 'row projects', 'bind row', 'restrict row', 'per project', 'grid dispatch', 'scope row', 'multiple projects'],
    when: ({ workspace }) => Boolean(workspace.state.dispatchMode?.tiled),
    getState: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return null
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
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      if (rowIndex >= 0) useAppStore.getState().openDispatchRowProjectPicker(rowIndex)
    },
  },
  {
    id: 'dispatch-row-child-cap',
    category: 'layout-dispatch',
    surface: 'dispatch',
    title: 'Nested Agents',
    description: '**What it does:** Switches the focused row\'s index between capping a parent\'s nested children and showing all of them.\n\n**Use when:** A parent has spawned enough workers to bury every other agent in the list.\n\n**Notes:** Applies to both orchestration children and manually linked agents — Dispatch nests them identically, so the cap cannot tell them apart. Only nested children are ever hidden; top-level agents always show, because the parent is what reports. Hiding a child never renumbers anything: labels and ⌘N stay on the full canonical list.',
    keywords: ['nested', 'orchestrated', 'orchestration', 'linked', 'children', 'collapse', 'expand', 'sub agents', 'workers', 'cap'],
    when: ({ workspace }) => Boolean(workspace.state.dispatchMode?.tiled),
    getState: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return null
      const grid = normalizeGridShape(tiled)
      const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
      const capped = rowIndex >= 0 ? grid.rows[rowIndex]?.capChildren !== false : true
      return value(capped ? 'Capped' : 'All')
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled) return
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
    surface: 'dispatch',
    title: 'Focus Row Above',
    description: '**What it does:** Moves lane focus to the row above, keeping the same column where the row is wide enough.\n\n**Use when:** You are driving a grid from the keyboard.\n\n**Notes:** Moving focus never changes any lane\'s agent.',
    keywords: ['focus row', 'row above', 'up', 'grid dispatch', 'navigate rows'],
    when: ({ workspace }) => Boolean(workspace.state.dispatchMode?.tiled),
    run: ({ workspace }) => focusAdjacentRow(workspace, -1),
  },
  {
    id: 'dispatch-focus-row-down',
    category: 'layout-dispatch',
    surface: 'dispatch',
    title: 'Focus Row Below',
    description: '**What it does:** Moves lane focus to the row below, keeping the same column where the row is wide enough.\n\n**Use when:** You are driving a grid from the keyboard.\n\n**Notes:** Moving focus never changes any lane\'s agent.',
    keywords: ['focus row', 'row below', 'down', 'grid dispatch', 'navigate rows'],
    when: ({ workspace }) => Boolean(workspace.state.dispatchMode?.tiled),
    run: ({ workspace }) => focusAdjacentRow(workspace, 1),
  },
  // REMOVED: the 'toggle-dispatch-terminal' command, then its replacement
  // `settings.dispatchProjectTerminal`, and now the feature itself. The
  // opt-in auto-created companion terminal and its dedicated Dispatch side
  // column are gone; user-created terminals still work exactly as before.
  {
    id: 'normalize-layout',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // `grid`: this rebalances `tab.root` split ratios. Dispatch does not
    // render the grid, so in Dispatch this was a silent no-op (issue
    // #228). Surface-gating hides it there instead of running invisibly.
    surface: 'grid',
    title: 'Normalize Layout',
    description: '**What it does:** Rebalances pane sizes in the current layout.\n\n**Use when:** Panes feel uneven but the layout shape is still useful.\n\n**Notes:** Keeps the same split structure.',
    run: ({ workspace }) => workspace.normalizeLayout(),
  },
  {
    id: 'hard-normalize-layout',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'grid',
    title: 'Hard Normalize Layout',
    description: '**What it does:** Rebuilds pane sizing into a cleaner even layout.\n\n**Use when:** The layout is messy and needs a stronger reset.\n\n**Notes:** More aggressive than **Normalize Layout**.',
    run: ({ workspace }) => workspace.hardNormalizeLayout(),
  },
  {
    id: 'rotate-layout',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'grid',
    title: 'Rotate Layout',
    description: '**What it does:** Rotates split directions in the current layout.\n\n**Use when:** The same panes would work better in a different orientation.\n\n**Notes:** Keeps the sessions, changes the arrangement.',
    run: ({ workspace }) => workspace.rotateLayout(),
  },
  // RETIRED: `toggle-status-mode`. Status Mode is a persisted app preference
  // with no meaningful momentary scope — there is no "just for this session"
  // version of it — so it has one product home, and that home is Settings
  // (Appearance → Status Mode, backed by `showStatusMode`). A command that
  // duplicates a durable preference gives the same setting two owners and two
  // places to look when it is wrong.
  {
    id: 'toggle-performance-panel',
    category: 'developer',
    pickerVisibility: 'debug',
    surface: 'debug',
    title: 'Performance Stats',
    description: '**What it does:** Shows or hides the performance stats panel.\n\n**Use when:** You want render, pane, or runtime performance details.\n\n**Notes:** Mostly useful while debugging the app.',
    keywords: ['performance', 'stats', 'cpu', 'memory', 'panes'],
    getState: ({ flags }) => toggle(flags.performancePanelOpen),
    run: ({ ui }) => ui.togglePerformancePanel(),
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
  const tiled = workspace.state.dispatchMode?.tiled
  if (!tiled) return
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
  const tiled = state.dispatchMode?.tiled
  if (!tiled) return false
  if (!tiled.lanes[tiled.focusedLane]) return false
  const grid = normalizeGridShape(tiled)
  const rowIndex = rowIndexForLane(grid.rows, grid.focusedLane)
  if (rowIndex < 0) return false
  return (
    (grid.rows[rowIndex]?.length ?? 0) < MAX_DISPATCH_TILES &&
    grid.lanes.length < MAX_DISPATCH_LANES
  )
}
