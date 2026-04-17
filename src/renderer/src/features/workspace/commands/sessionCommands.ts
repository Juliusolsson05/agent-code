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
    // Cross-session prompt search — session names are useless for
    // finding a conversation, so this command opens a modal that
    // ranks every session on disk by its user-prompt text instead.
    // Always available; doesn't depend on a focused session because
    // the whole point is to find a session when you don't know which
    // pane to focus first.
    id: 'search-conversation-prompts',
    title: 'Search Conversation Prompts',
    keywords: [
      'search',
      'prompt',
      'prompts',
      'conversation',
      'find',
      'session',
      'sessions',
      'recent',
      'history',
    ],
    run: ({ ui }) => {
      ui.openPromptSearch()
      ui.closePalette()
    },
  },
  {
    id: 'reload-agent',
    title: 'Reload Agent',
    keywords: ['reload', 'resume', 'agent', 'claude', 'codex', 'reconnect'],
    getState: ({ workspace }) => {
      const tab = workspace.activeTab
      const meta = tab ? workspace.state.sessions[tab.focusedSessionId] : null
      const kind = meta?.kind ?? 'claude'
      return {
        label: kind === 'codex' ? 'Codex' : 'Claude',
        tone: 'neutral',
      }
    },
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
    title: 'Switch Provider',
    keywords: ['provider', 'switch', 'claude', 'codex', 'translate'],
    getState: ({ workspace }) => {
      const tab = workspace.activeTab
      const meta = tab ? workspace.state.sessions[tab.focusedSessionId] : null
      const kind = meta?.kind ?? 'claude'
      return {
        label: kind === 'codex' ? 'Codex' : 'Claude',
        tone: 'neutral',
      }
    },
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
    title: 'Git Bar',
    getState: ({ flags }) => ({
      label: flags.gitBarOpen ? 'On' : 'Off',
      tone: flags.gitBarOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleGitBar(),
  },
  {
    id: 'toggle-debug-panel',
    title: 'Debug Panel',
    getState: ({ flags }) => ({
      label: flags.debugPanelOpen ? 'On' : 'Off',
      tone: flags.debugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleDebugPanel(),
  },
  {
    id: 'toggle-proxy-debug-panel',
    title: 'Proxy Debug Panel',
    keywords: ['proxy', 'sse', 'stream', 'semantic', 'anthropic', 'debug'],
    getState: ({ flags }) => ({
      label: flags.proxyDebugPanelOpen ? 'On' : 'Off',
      tone: flags.proxyDebugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleProxyDebugPanel(),
  },
]
