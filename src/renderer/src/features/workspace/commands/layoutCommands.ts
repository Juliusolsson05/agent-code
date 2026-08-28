import type { CommandDef } from '@renderer/features/command-palette/types'
import { status, toggle, value } from '@renderer/features/command-palette/commandState'
import {
  MAX_DISPATCH_TILES,
  MIN_DISPATCH_TILES,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { resolveStrictDispatchCommandTarget } from '@renderer/workspace/dispatch/dispatchTarget'

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
    title: 'Tiled Dispatch',
    description: '**What it does:** Opens a multi-lane **Dispatch** layout — the full agent index plus several live agent lanes side by side.\n\n**Use when:** You want to watch and drive multiple agents at once.\n\n**Notes:** Prompts for a tile count (1–10). The leftmost lane is the full index; every other lane has its own compact selector. Re-run to change the tile count (existing lane selections are preserved). Return to the normal grid with **Dispatch Mode**.',
    keywords: ['tiled dispatch', 'multi agent', 'lanes', 'split dispatch', 'cockpit', 'parallel agents', 'grid of agents'],
    run: ({ ui }) => ui.openTiledDispatchPrompt(),
  },
  {
    id: 'new-tiled-lane',
    category: 'layout-dispatch',
    surface: 'dispatch',
    title: 'New Lane',
    description: '**What it does:** Inserts a new lane immediately to the **right of the focused lane** in Tiled Dispatch.\n\n**Use when:** You want another live agent view without reopening the tile-count prompt or disturbing the lanes around it.\n\n**Notes:** The current lane stays focused and the new lane arrives empty — adding a lane asks for space, not for a particular agent. Focus it and press ⌥↓ to put the first agent in it, or pick one from its strip.',
    keywords: ['new lane', 'add lane', 'insert lane', 'tiled dispatch', 'expand', 'right'],
    when: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      return Boolean(
        tiled &&
        tiled.lanes.length < MAX_DISPATCH_TILES &&
        tiled.lanes[tiled.focusedLane],
      )
    },
    run: ({ workspace }) => {
      const tiled = workspace.state.dispatchMode?.tiled
      if (!tiled || tiled.lanes.length >= MAX_DISPATCH_TILES) return
      const laneIndex = tiled.focusedLane
      const sourceLane = tiled.lanes[laneIndex]
      if (!sourceLane) return
      // The raw lane id can still name a globally live but OUT-OF-SCOPE session
      // during the render before TiledDispatchLayout heals it. Use the same
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
    description: '**What it does:** Removes the **focused lane** from Tiled Dispatch, shrinking the layout by one lane. The agent keeps running and stays in the index.\n\n**Use when:** You are done watching one agent but want the others to stay exactly where they are.\n\n**Notes:** Changing the tile count instead always drops the LAST lane. Removing the leftmost lane promotes the next one into its place, where it is selected from the full index rather than its own compact selector.',
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
      // Liveness, not mere presence: a lane can hold a set-but-dead id for the
      // render between a session disappearing (killed from Agent Activity, tab
      // closed) and the layout's heal effect clearing it. Admitting on presence
      // alone let the command run, find nothing to close, and silently do
      // neither of the two things its title promises.
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
