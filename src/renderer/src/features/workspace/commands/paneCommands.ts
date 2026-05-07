import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import {
  detachedDispatchSessionIdsForTab,
  buildDispatchGroups,
  flattenDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'

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
    // Promote the dispatch-focused detached agent into the active
    // tab's grid via the existing placement-target picker. Available
    // only when Dispatch Mode is active AND its current focus is on a
    // detached session (grid-focused rows in the dispatch list don't
    // need attaching — they're already attached).
    id: 'attach-detached-to-grid',
    title: 'Attach Detached Agent To Grid…',
    description: '**What it does:** Moves one **detached Dispatch agent** into the grid.\n\n**Use when:** You want to pin background work into the normal layout.\n\n**Notes:** Uses the placement picker so you can choose where it lands.',
    keywords: ['attach', 'detached', 'dispatch', 'grid', 'pin', 'place'],
    when: ({ workspace }) => {
      if (!workspace.dispatchMode) return false
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return Boolean(workspace.state.detachedSessions[sessionId])
    },
    run: ({ workspace, ui }) => {
      if (!workspace.dispatchMode) return
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      if (!workspace.state.detachedSessions[sessionId]) return
      ui.openDispatchAttach(sessionId)
    },
  },
  {
    id: 'attach-all-detached-for-tab',
    title: 'Attach All Dispatch Agents For Tab',
    description: '**What it does:** Moves all detached **Dispatch** agents for a tab into the grid.\n\n**Use when:** You want to bring a whole tab’s background agents into view.\n\n**Notes:** Preserves the existing grid and adds the agents beside it.',
    keywords: ['attach', 'all', 'detached', 'dispatch', 'grid', 'tab', 'pin'],
    when: ({ workspace }) => {
      const tabId = dispatchCommandTabId(workspace)
      if (!tabId) return false
      return detachedDispatchSessionIdsForTab(workspace.state, tabId).length > 0
    },
    run: ({ workspace }) => {
      const tabId = dispatchCommandTabId(workspace)
      if (!tabId) return
      workspace.attachAllDetachedForTab(tabId)
    },
  },
  {
    // The reverse of attach: take the focused grid pane out of the
    // tile tree without killing it and add it to the dispatch
    // detached bucket. Refuses on the action side (with a toast) for
    // terminals and for the only-leaf-in-tab case; the `when` check
    // here just gates on having any non-terminal focused leaf so the
    // command shows up in the palette.
    id: 'detach-to-dispatch',
    title: 'Detach Agent To Dispatch',
    description: '**What it does:** Moves a grid agent into **Dispatch** without killing it.\n\n**Use when:** You want to park work in the background.\n\n**Notes:** Terminals cannot be detached to **Dispatch**.',
    keywords: ['detach', 'dispatch', 'park', 'background', 'unpin'],
    when: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return false
      const sessionId = tab.focusedSessionId
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      return Boolean(meta) && meta.kind !== 'terminal'
    },
    run: ({ workspace }) => workspace.detachFocusedToDispatch(),
  },
  {
    id: 'terminal-horizontal',
    title: 'New Terminal Right',
    description: '**What it does:** Opens a **terminal on the right**.\n\n**Use when:** You need a shell beside the current pane.\n\n**Notes:** Shortcut: **⌥T**.',
    shortcut: '⌥T',
    run: ({ workspace }) => void workspace.splitFocused('vertical', 'terminal'),
  },
  {
    id: 'terminal-vertical',
    title: 'New Terminal Below',
    description: '**What it does:** Opens a **terminal below**.\n\n**Use when:** You need a shell under the current pane.\n\n**Notes:** Shortcut: **⌥⇧T**.',
    shortcut: '⌥⇧T',
    run: ({ workspace }) => void workspace.splitFocused('horizontal', 'terminal'),
  },
  {
    id: 'codex-vertical',
    title: 'New Codex Right',
    description: '**What it does:** Opens a **Codex agent on the right**.\n\n**Use when:** You want Codex beside the current agent.\n\n**Notes:** Shortcut: **⌥C**.',
    shortcut: '⌥C',
    run: ({ workspace }) => void workspace.splitFocused('vertical', 'codex'),
  },
  {
    id: 'codex-horizontal',
    title: 'New Codex Below',
    description: '**What it does:** Opens a **Codex agent below**.\n\n**Use when:** You want Codex in a stacked layout.\n\n**Notes:** Shortcut: **⌥⇧C**.',
    shortcut: '⌥⇧C',
    run: ({ workspace }) => void workspace.splitFocused('horizontal', 'codex'),
  },
  {
    id: 'nav-left',
    title: 'Focus Pane Left',
    description: '**What it does:** Focuses the pane to the **left**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Shortcut: **⌥H**.',
    shortcut: '⌥H',
    run: ({ workspace }) => workspace.navigate('left'),
  },
  {
    id: 'nav-right',
    title: 'Focus Pane Right',
    description: '**What it does:** Focuses the pane to the **right**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Shortcut: **⌥L**.',
    shortcut: '⌥L',
    run: ({ workspace }) => workspace.navigate('right'),
  },
  {
    id: 'nav-up',
    title: 'Focus Pane Up',
    description: '**What it does:** Focuses the pane **above**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Shortcut: **⌥K**.',
    shortcut: '⌥K',
    run: ({ workspace }) => workspace.navigate('up'),
  },
  {
    id: 'nav-down',
    title: 'Focus Pane Down',
    description: '**What it does:** Focuses the pane **below**.\n\n**Use when:** You want keyboard pane navigation.\n\n**Notes:** Shortcut: **⌥J**.',
    shortcut: '⌥J',
    run: ({ workspace }) => workspace.navigate('down'),
  },
  {
    id: 'undo-close',
    title: 'Undo Close',
    description: '**What it does:** Restores the last closed **pane or tab**.\n\n**Use when:** You closed something by mistake.\n\n**Notes:** Shortcut: **⌘⇧T**.',
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
    flattenDispatchRows(buildDispatchGroups(workspace.state)),
    workspace.dispatchMode.focusedSessionId,
    activeTab?.focusedSessionId,
  )
  return row?.tabId ?? workspace.state.activeTabId ?? null
}
