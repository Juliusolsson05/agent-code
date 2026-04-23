import { extractLastAssistantText } from '../../../lib/copyAssistant'
import type { CommandDef } from '../../command-palette/types'

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
    when: ({ workspace }) => workspace.state.buried.length > 0,
    run: ({ ui }) => ui.enterBuriedMode(),
  },
  {
    id: 'toggle-tail',
    title: 'Tail',
    getState: ({ workspace }) => {
      const tab = workspace.activeTab
      const tailMode = tab
        ? workspace.getRuntime(tab.focusedSessionId).tailMode
        : false
      return {
        label: tailMode ? 'On' : 'Off',
        tone: tailMode ? 'accent' : 'neutral',
      }
    },
    run: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return
      workspace.toggleTailMode(tab.focusedSessionId)
    },
  },
  {
    id: 'jump-latest-message',
    title: 'Jump to Latest Message',
    shortcut: 'End',
    when: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return false
      const kind = workspace.state.sessions[tab.focusedSessionId]?.kind ?? 'claude'
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
      const tab = workspace.activeTab
      if (!tab) return
      const sessionId = tab.focusedSessionId
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
