import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import {
  commandTargetSessionId,
  commandTargetSessionIdForState,
} from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { isDetached } from '@renderer/workspace/queries'
import {
  buildVisibleDispatchRows,
  detachedDispatchSessionIdsForTab,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

export const paneCommands: CommandDef[] = [
  {
    id: 'new-agent',
    title: 'New Agent…',
    description: '**What it does:** Starts a **new agent or terminal**.\n\n**Use when:** You want another Claude, Codex, or shell pane.\n\n**Notes:** In **Dispatch**, this creates a detached agent instead of changing the grid.',
    keywords: ['new', 'agent', 'placement', 'claude', 'codex', 'terminal'],
    when: ({ workspace }) => Boolean(workspace.activeTab && !workspace.tileTabs),
    run: ({ workspace }) => workspace.startNewAgentPlacement(),
  },
  {
    id: 'split-vertical',
    title: 'Split Pane Right',
    description: '**What it does:** Creates a **new agent pane on the right**.\n\n**Use when:** You want side-by-side work in the grid.\n\n**Notes:** In **Dispatch**, this creates a detached agent instead.',
    shortcut: '⌥D',
    run: ({ workspace }) => void workspace.splitFocused('vertical'),
  },
  {
    id: 'split-horizontal',
    title: 'Split Pane Down',
    description: '**What it does:** Creates a **new agent pane below**.\n\n**Use when:** You want a stacked grid layout.\n\n**Notes:** In **Dispatch**, this creates a detached agent instead.',
    shortcut: '⌥⇧D',
    run: ({ workspace }) => void workspace.splitFocused('horizontal'),
  },
  {
    id: 'close-pane',
    title: 'Close Pane',
    description: '**What it does:** Closes the **currently targeted pane or Dispatch row**.\n\n**Use when:** You are done with the current target.\n\n**Notes:** In **Dispatch**, the highlighted row is the close target.',
    shortcut: '⌘W',
    run: ({ workspace }) => void workspace.closeFocused(),
  },
  {
    id: 'bury-pane',
    title: 'Bury Pane',
    description: '**What it does:** Hides the pane but keeps the **session alive**.\n\n**Use when:** You want it out of the layout without killing it.\n\n**Notes:** Buried panes can be revived later.',
    run: ({ workspace }) => workspace.requestBuryFocused(),
  },
  {
    id: 'linked-agent',
    title: 'Linked Agent…',
    description: '**What it does:** Starts a new Claude or Codex agent linked to the currently targeted agent.\n\n**Use when:** You want a one-off helper, like a review agent, visually nested under the parent.\n\n**Notes:** The linked agent is a normal Dispatch agent. It renders directly under the parent and closes automatically when the parent closes.',
    keywords: ['linked', 'agent', 'review', 'helper', 'child', 'dispatch', 'claude', 'codex'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const kind = workspace.state.sessions[sessionId]?.kind
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const kind = workspace.state.sessions[sessionId]?.kind
      if (kind !== 'claude' && kind !== 'codex') return
      ui.openLinkedAgent(sessionId)
    },
  },
  {
    // Promote the dispatch-focused detached session into the active
    // tab's grid via the existing placement-target picker. Available
    // only when Dispatch Mode is active AND its current focus is on a
    // detached session (grid-focused rows in the dispatch list don't
    // need attaching — they're already attached).
    id: 'attach-detached-to-grid',
    title: 'Attach Detached Session To Grid…',
    description: '**What it does:** Moves one **detached Dispatch session** into the grid.\n\n**Use when:** You want to pin background work into the normal layout.\n\n**Notes:** Uses the placement picker so you can choose where it lands.',
    keywords: ['attach', 'detached', 'dispatch', 'grid', 'pin', 'place'],
    when: ({ workspace }) => {
      if (!workspace.dispatchMode) return false
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return isDetached(workspace.state, sessionId)
    },
    run: ({ workspace, ui }) => {
      if (!workspace.dispatchMode) return
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      if (!isDetached(workspace.state, sessionId)) return
      ui.openDispatchAttach(sessionId)
    },
  },
  {
    // Dispatch-only multi-select pin command. Opens the Pin Agents
    // modal; the user picks agents with Space, commits with Enter,
    // and the resulting ordered list lands on
    // workspace.state.pinnedSessionIds. Pinned agents render in
    // their own "Pinned" section at the top of the dispatch list,
    // visible in BOTH project and global scope — the whole point of
    // pins is that they survive the scope toggle.
    //
    // We gate on dispatchMode rather than the dispatch-row count
    // because the modal handles the empty case ("No agents
    // available to pin") gracefully. Showing the command in an
    // empty workspace is fine — running it just opens a modal that
    // tells the user there's nothing to pin yet, which is more
    // discoverable than hiding the entry altogether.
    id: 'pin-agents',
    title: 'Pin Agents…',
    description: '**What it does:** Opens the multi-select Pin modal to choose which **Dispatch** agents stay pinned at the top of the agent list.\n\n**Use when:** You want a few favorite agents to always be one keystroke away regardless of project or scope.\n\n**Notes:** Space toggles, Enter commits, Esc cancels. The order you Space through the rows is the order pins render in. Pins survive project↔global scope toggles.',
    keywords: ['pin', 'pins', 'pinned', 'favorite', 'star', 'top', 'dispatch'],
    when: ({ workspace }) => Boolean(workspace.dispatchMode),
    run: ({ ui }) => ui.openPinAgents(),
  },
  {
    // Quick-remove counterpart to pin-agents. Targets the currently
    // dispatch-focused row so the keyboard-driven flow is "navigate
    // to a pinned row, run Unpin Agent." We use the same
    // commandTargetSessionId resolver the rest of this file uses
    // for dispatch-aware target picking, so the highlighted row in
    // the dispatch list IS the unpin target.
    //
    // The `when` guard is intentionally strict: only show the
    // command if the focused row is currently pinned. Showing it
    // unconditionally would lead users to "Unpin Agent" on a
    // non-pinned row, which silently no-ops in the reducer — bad
    // affordance.
    id: 'unpin-agent',
    title: 'Unpin Agent',
    description: '**What it does:** Removes the currently-focused **Dispatch** row from the Pinned section.\n\n**Use when:** You want to quickly drop a single pin without opening the Pin modal.\n\n**Notes:** Only appears when the focused dispatch row is currently pinned.',
    keywords: ['unpin', 'remove', 'pin', 'pinned', 'star'],
    when: ({ workspace }) => {
      if (!workspace.dispatchMode) return false
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return workspace.state.pinnedSessionIds.includes(sessionId)
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      workspace.unpinSession(sessionId)
    },
  },
  {
    // Available in BOTH grid and Dispatch modes. The original gate was
    // `dispatchCommandTabId`, which returned null whenever the workspace
    // was not in Dispatch — that was the wrong shape for this command.
    // Detached agents can outlive a Dispatch session (you can leave
    // Dispatch with agents still parked), and the natural recovery flow
    // is "from the regular grid, bring my parked agents back into this
    // tab." Forcing the user to flip into Dispatch first was friction
    // with no upside. In Dispatch we still delegate to the dispatch-
    // aware resolver so global Dispatch can target the focused row's
    // tab (which may differ from `activeTabId`).
    id: 'attach-all-detached-for-tab',
    title: 'Attach All Dispatch Sessions For Tab',
    description: '**What it does:** Moves all detached **Dispatch** sessions for a tab into the grid.\n\n**Use when:** You want to bring a whole tab’s background work into view.\n\n**Notes:** Preserves the existing grid and adds the sessions beside it. Works in both Grid and Dispatch modes.',
    keywords: ['attach', 'all', 'detached', 'dispatch', 'grid', 'tab', 'pin'],
    when: ({ workspace }) => {
      const tabId = attachAllCommandTabId(workspace)
      if (!tabId) return false
      return detachedDispatchSessionIdsForTab(workspace.state, tabId).length > 0
    },
    run: ({ workspace }) => {
      const tabId = attachAllCommandTabId(workspace)
      if (!tabId) return
      workspace.attachAllDetachedForTab(tabId)
    },
  },
  {
    // The reverse of attach: take the focused grid pane out of the
    // tile tree without killing it and add it to the dispatch
    // detached bucket. The action side refuses the only-leaf-in-tab
    // case; this `when` check gates on an actual grid leaf so the command
    // does not show for a session that is already detached.
    id: 'detach-to-dispatch',
    title: 'Detach Session To Dispatch',
    description: '**What it does:** Moves a grid session into **Dispatch** without killing it.\n\n**Use when:** You want to park work in the background.\n\n**Notes:** The last pane in a tab cannot be detached.',
    keywords: ['detach', 'dispatch', 'park', 'background', 'unpin'],
    when: ({ workspace }) => {
      // Use the Dispatch-aware target resolver, not tab.focusedSessionId.
      // tab.focusedSessionId has a "must be a leaf in tab.root" invariant
      // — i.e. it's grid-only. In Dispatch Mode the user has a row
      // selected, not a grid focus, and reading tab.focusedSessionId
      // silently misses that selection: the command would either gate
      // off entirely or target a stale grid leaf. The action itself
      // (`workspace.detachFocusedToDispatch`) already routes through
      // the Dispatch-aware target; this gate must agree or the palette
      // shows/hides the command for the wrong reason.
      if (!workspace.activeTab) return false
      const sessionId = commandTargetSessionIdForState(workspace.state)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const owner = workspace.state.tabs.find(tab => collectLeaves(tab.root).includes(sessionId))
      return Boolean(meta && owner)
    },
    run: ({ workspace }) => workspace.detachFocusedToDispatch(),
  },
  {
    id: 'terminal-horizontal',
    title: 'New Terminal Right',
    description: '**What it does:** Opens a **terminal on the right**.\n\n**Use when:** You need a shell beside the current pane.\n\n**Notes:** Terminals always attach to the grid, even from **Dispatch**.',
    shortcut: '⌥T',
    run: ({ workspace }) => void workspace.splitFocused('vertical', 'terminal'),
  },
  {
    id: 'terminal-vertical',
    title: 'New Terminal Below',
    description: '**What it does:** Opens a **terminal below**.\n\n**Use when:** You need a shell under the current pane.\n\n**Notes:** Terminals always attach to the grid, even from **Dispatch**.',
    shortcut: '⌥⇧T',
    run: ({ workspace }) => void workspace.splitFocused('horizontal', 'terminal'),
  },
  {
    id: 'codex-vertical',
    title: 'New Codex Right',
    description: '**What it does:** Opens a **Codex agent on the right**.\n\n**Use when:** You want Codex beside the current agent.\n\n**Notes:** In **Dispatch**, this creates a detached Codex agent instead.',
    shortcut: '⌥C',
    run: ({ workspace }) => void workspace.splitFocused('vertical', 'codex'),
  },
  {
    id: 'codex-horizontal',
    title: 'New Codex Below',
    description: '**What it does:** Opens a **Codex agent below**.\n\n**Use when:** You want Codex in a stacked layout.\n\n**Notes:** In **Dispatch**, this creates a detached Codex agent instead.',
    shortcut: '⌥⇧C',
    run: ({ workspace }) => void workspace.splitFocused('horizontal', 'codex'),
  },
  {
    id: 'nav-left',
    title: 'Focus Pane Left',
    description: '**What it does:** Focuses the pane to the **left**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    shortcut: '⌥H',
    run: ({ workspace }) => workspace.navigate('left'),
  },
  {
    id: 'nav-right',
    title: 'Focus Pane Right',
    description: '**What it does:** Focuses the pane to the **right**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    shortcut: '⌥L',
    run: ({ workspace }) => workspace.navigate('right'),
  },
  {
    id: 'nav-up',
    title: 'Focus Pane Up',
    description: '**What it does:** Focuses the pane **above**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    shortcut: '⌥K',
    run: ({ workspace }) => workspace.navigate('up'),
  },
  {
    id: 'nav-down',
    title: 'Focus Pane Down',
    description: '**What it does:** Focuses the pane **below**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Uses the current grid layout.',
    shortcut: '⌥J',
    run: ({ workspace }) => workspace.navigate('down'),
  },
  {
    id: 'undo-close',
    title: 'Undo Close',
    description: '**What it does:** Restores the most recent closed **pane or tab** from a small recent-close history.\n\n**Use when:** You closed something by mistake, or repeat it to walk back through earlier closes.\n\n**Notes:** Also restores detached **Dispatch** agents captured with a closed tab.',
    shortcut: '⌘⇧T',
    run: ({ workspace }) => void workspace.undoClose(),
  },
  {
    id: 'revive-pane',
    title: 'Revive Buried Pane',
    description: '**What it does:** Restores a **buried live pane**.\n\n**Use when:** You parked a session and want it back.\n\n**Notes:** Opens a picker when multiple buried panes exist.',
    keepPaletteOpen: true,
    when: ({ workspace }) => workspace.state.buried.length > 0,
    run: ({ ui }) => ui.enterBuriedMode(),
  },
  {
    id: 'kill-buried-pane',
    title: 'Kill Buried Pane…',
    description: '**What it does:** Permanently kills a **buried session**.\n\n**Use when:** You no longer need hidden background work.\n\n**Notes:** This is destructive.',
    keywords: ['kill', 'buried', 'hidden', 'pane', 'session'],
    keepPaletteOpen: true,
    when: ({ workspace }) => workspace.state.buried.length > 0,
    run: ({ ui }) => ui.enterKillBuriedMode(),
  },
  {
    id: 'toggle-tail',
    title: 'Tail',
    description: '**What it does:** Toggles feed **auto-follow** for the focused target.\n\n**Use when:** You want output to stay pinned to the bottom.\n\n**Notes:** Applies to the visible command target, including **Dispatch** selection.',
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const tailMode = sessionId
        ? workspace.getRuntime(sessionId).tailMode
        : false
      return {
        label: tailMode ? 'On' : 'Off',
        tone: tailMode ? 'accent' : 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      // WHY tail is agent-only even though terminals are Dispatch rows:
      // tailMode controls the rendered transcript/feed scroll container.
      // Terminal panes delegate scrollback to xterm.js, so toggling this
      // runtime flag on a terminal would present a command that appears to
      // work while changing nothing visible.
      return workspace.state.sessions[sessionId]?.kind !== 'terminal'
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      workspace.toggleTailMode(sessionId)
    },
  },
  {
    id: 'jump-latest-message',
    title: 'Jump to Latest Message',
    description: '**What it does:** Scrolls to the **latest agent message**.\n\n**Use when:** You are far up in the feed and want to return to the bottom.\n\n**Notes:** Agent panes only.',
    shortcut: 'End',
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const kind = workspace.state.sessions[sessionId]?.kind ?? 'claude'
      return kind !== 'terminal'
    },
    run: ({ workspace }) => {
      workspace.scrollFocusedToLatest()
    },
  },
  {
    id: 'copy-last-assistant',
    title: 'Copy Last Response',
    description: '**What it does:** Copies the **latest assistant response**.\n\n**Use when:** You want the most recent answer quickly.\n\n**Notes:** No picker; copies immediately.',
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      // WHY hide this for terminals: terminal output is not an assistant
      // transcript, and extractLastAssistantText intentionally reads provider
      // entries. Showing the command on a shell row would imply there is an
      // assistant response to copy when there is only PTY scrollback.
      return workspace.state.sessions[sessionId]?.kind !== 'terminal'
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const runtime = workspace.getRuntime(sessionId)
      const kind = workspace.state.sessions[sessionId]?.kind ?? 'claude'
      const text = extractLastAssistantText(runtime.entries, kind)
      if (text) {
        void navigator.clipboard.writeText(text)
        workspace.showPaneToast(sessionId, 'Copied to clipboard')
      }
    },
  },
]

function dispatchCommandTabId(
  workspace: CommandContext['workspace'],
): string | null {
  if (!workspace.dispatchMode) return null
  if (workspace.dispatchMode.scope !== 'global') {
    return workspace.state.activeTabId || null
  }
  const activeTab = workspace.activeTab
  const row = selectVisibleDispatchRow(
    buildVisibleDispatchRows(workspace.state),
    workspace.dispatchMode.focusedSessionId,
    activeTab?.focusedSessionId,
  )
  return row?.tabId ?? workspace.state.activeTabId ?? null
}

// Resolver for "attach all dispatch agents for tab" that works in BOTH
// modes. In Dispatch we delegate to `dispatchCommandTabId` so global
// Dispatch can target the focused row's tab (potentially != activeTabId).
// Outside Dispatch we use the active tab — there is no dispatch focus
// to consult and the user's only reasonable target is "this tab."
function attachAllCommandTabId(
  workspace: CommandContext['workspace'],
): string | null {
  if (workspace.dispatchMode) return dispatchCommandTabId(workspace)
  return workspace.state.activeTabId || null
}
