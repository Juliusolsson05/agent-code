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
    id: 'duplicate-agent',
    title: 'Duplicate Agent',
    keywords: ['duplicate', 'clone', 'fork', 'copy', 'session', 'agent'],
    when: ({ workspace }) => {
      // Needs a focused agent session that has a providerSessionId
      // — without that id there's nothing on disk to duplicate.
      const tab = workspace.activeTab
      if (!tab) return false
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return (
        (kind === 'claude' || kind === 'codex') &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: async ({ workspace, ui }) => {
      const tab = workspace.activeTab
      if (!tab) return
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      if (!meta?.providerSessionId) return
      try {
        const { newProviderSessionId } = await window.api.duplicateSession({
          provider: kind,
          sourceProviderSessionId: meta.providerSessionId,
          cwd: meta.cwd,
        })
        ui.closePalette()
        // Open the clone as a SIBLING pane (vertical split) of the
        // source. Using `workspace.newTab` would push the clone into
        // a new tab and hide the source behind a tab switch — not
        // what "duplicate" should do. Using `splitFocused` places
        // both side-by-side so the user can see and interact with
        // them at once.
        await workspace.splitFocused('vertical', kind, newProviderSessionId)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[duplicate-agent] failed', err)
      }
    },
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
