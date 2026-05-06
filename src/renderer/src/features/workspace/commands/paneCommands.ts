import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export const paneCommands: CommandDef[] = [
  {
    id: 'new-agent',
    title: 'New Agent…',
    keywords: ['new', 'agent', 'placement', 'claude', 'codex', 'terminal'],
    when: ({ workspace }) => Boolean(workspace.activeTab && !workspace.tileTabs),
    run: ({ workspace }) => workspace.startNewAgentPlacement(),
  },
  {
    id: 'split-vertical',
    title: 'Split Pane Right',
    shortcut: '⌥D',
    run: ({ workspace }) => void workspace.splitFocused('vertical'),
  },
  {
    id: 'split-horizontal',
    title: 'Split Pane Down',
    shortcut: '⌥⇧D',
    run: ({ workspace }) => void workspace.splitFocused('horizontal'),
  },
  {
    id: 'close-pane',
    title: 'Close Pane',
    shortcut: '⌘W',
    run: ({ workspace }) => void workspace.closeFocused(),
  },
  {
    id: 'bury-pane',
    title: 'Bury Pane',
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
    // The reverse of attach: take the focused grid pane out of the
    // tile tree without killing it and add it to the dispatch
    // detached bucket. Refuses on the action side (with a toast) for
    // terminals and for the only-leaf-in-tab case; the `when` check
    // here just gates on having any non-terminal focused leaf so the
    // command shows up in the palette.
    id: 'detach-to-dispatch',
    title: 'Detach Agent To Dispatch',
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
    shortcut: '⌥T',
    run: ({ workspace }) => void workspace.splitFocused('vertical', 'terminal'),
  },
  {
    id: 'terminal-vertical',
    title: 'New Terminal Below',
    shortcut: '⌥⇧T',
    run: ({ workspace }) => void workspace.splitFocused('horizontal', 'terminal'),
  },
  {
    id: 'codex-vertical',
    title: 'New Codex Right',
    shortcut: '⌥C',
    run: ({ workspace }) => void workspace.splitFocused('vertical', 'codex'),
  },
  {
    id: 'codex-horizontal',
    title: 'New Codex Below',
    shortcut: '⌥⇧C',
    run: ({ workspace }) => void workspace.splitFocused('horizontal', 'codex'),
  },
  {
    id: 'nav-left',
    title: 'Focus Pane Left',
    shortcut: '⌥H',
    run: ({ workspace }) => workspace.navigate('left'),
  },
  {
    id: 'nav-right',
    title: 'Focus Pane Right',
    shortcut: '⌥L',
    run: ({ workspace }) => workspace.navigate('right'),
  },
  {
    id: 'nav-up',
    title: 'Focus Pane Up',
    shortcut: '⌥K',
    run: ({ workspace }) => workspace.navigate('up'),
  },
  {
    id: 'nav-down',
    title: 'Focus Pane Down',
    shortcut: '⌥J',
    run: ({ workspace }) => workspace.navigate('down'),
  },
  {
    id: 'undo-close',
    title: 'Undo Close',
    shortcut: '⌘⇧T',
    run: ({ workspace }) => void workspace.undoClose(),
  },
  {
    id: 'revive-pane',
    title: 'Revive Buried Pane',
    keepPaletteOpen: true,
    when: ({ workspace }) => workspace.state.buried.length > 0,
    run: ({ ui }) => ui.enterBuriedMode(),
  },
  {
    id: 'kill-buried-pane',
    title: 'Kill Buried Pane…',
    keywords: ['kill', 'buried', 'hidden', 'pane', 'session'],
    keepPaletteOpen: true,
    when: ({ workspace }) => workspace.state.buried.length > 0,
    run: ({ ui }) => ui.enterKillBuriedMode(),
  },
  {
    id: 'toggle-tail',
    title: 'Tail',
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
