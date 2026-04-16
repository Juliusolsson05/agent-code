import type { CommandDef } from '../../../commands/types'

export const sessionCommands: CommandDef[] = [
  {
    id: 'view-prompts',
    title: 'View Prompts',
    keywords: ['prompts', 'history', 'user', 'modal', 'session', 'context'],
    when: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return false
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace, ui }) => {
      const tab = workspace.activeTab
      if (!tab) return
      ui.openViewPrompts(tab.focusedSessionId)
    },
  },
  {
    id: 'reload-agent',
    title: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return 'Reload Agent'
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'codex' ? 'Reload Codex Agent' : 'Reload Claude Agent'
    },
    keywords: ['reload', 'resume', 'agent', 'claude', 'codex', 'reconnect'],
    when: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return false
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return (kind === 'claude' || kind === 'codex') && Boolean(meta?.providerSessionId)
    },
    run: ({ workspace }) => void workspace.reloadFocusedAgent(),
  },
  {
    id: 'switch-provider',
    title: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return 'Switch Provider'
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'codex' ? 'Switch To Claude' : 'Switch To Codex'
    },
    keywords: ['provider', 'switch', 'claude', 'codex', 'translate'],
    when: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return false
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return (kind === 'claude' || kind === 'codex') && Boolean(meta?.providerSessionId)
    },
    run: ({ workspace }) => void workspace.switchFocusedProvider(),
  },
  {
    id: 'toggle-git-bar',
    title: 'Toggle Git Bar',
    run: ({ ui }) => ui.toggleGitBar(),
  },
  {
    id: 'toggle-debug-panel',
    title: 'Toggle Debug Panel',
    run: ({ ui }) => ui.toggleDebugPanel(),
  },
  {
    id: 'toggle-proxy-debug-panel',
    title: 'Toggle Proxy Debug Panel',
    keywords: ['proxy', 'sse', 'stream', 'semantic', 'anthropic', 'debug'],
    run: ({ ui }) => ui.toggleProxyDebugPanel(),
  },
]
