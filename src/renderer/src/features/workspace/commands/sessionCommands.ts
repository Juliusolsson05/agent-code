import type { CommandDef } from '@renderer/features/command-palette/types'
import { runSaveDebugBundleCommand } from '@renderer/features/debug/saveDebugBundle'

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
    // Rewind-to-Prompt — pick a past user prompt and re-home the
    // focused pane onto a truncated transcript ending just before
    // that prompt. The chosen prompt gets prefilled into the
    // composer as an unsent draft. The source session's on-disk
    // transcript is never touched. Inspiration: Claude Code's
    // double-tap Esc / `/rewind` command (see
    // claude-code-src/full/commands/rewind/rewind.ts and
    // `rewindConversationTo` in REPL.tsx).
    //
    // Requires a focused Claude/Codex pane with a providerSessionId
    // — rewind needs a file on disk to truncate from. The action
    // itself re-checks and surfaces a toast if the pane is
    // mid-stream.
    id: 'rewind-to-prompt',
    title: 'Rewind to Prompt…',
    keywords: [
      'rewind',
      'prompt',
      'user',
      'history',
      'revert',
      'undo',
      'back',
      'rollback',
      'fork',
      'branch',
      'checkpoint',
    ],
    when: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return false
      const meta = workspace.state.sessions[tab.focusedSessionId]
      const kind = meta?.kind ?? 'claude'
      return (
        (kind === 'claude' || kind === 'codex') &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: ({ workspace, ui }) => {
      const tab = workspace.activeTab
      if (!tab) return
      ui.openRewindPrompt(tab.focusedSessionId)
      ui.closePalette()
    },
  },
  {
    // Agent Activity — overview of every visible pane/session
    // grouped by tab, sorted by last activity. Primary use case is
    // triaging a long working session: scan which agents have gone
    // idle, close or bury the ones you're done with without having
    // to click through each tab. Always available — the modal
    // derives "last active" from existing transcript data, so it
    // needs nothing to be focused.
    id: 'open-agent-activity',
    title: 'Agent Activity…',
    keywords: [
      'agent',
      'activity',
      'panes',
      'sessions',
      'last',
      'active',
      'cleanup',
      'close',
      'idle',
      'overview',
    ],
    run: ({ ui }) => {
      ui.openAgentActivity()
      ui.closePalette()
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
    id: 'toggle-feed-debug-panel',
    title: 'Open Debug Logs',
    keywords: ['debug', 'logs', 'feed', 'render', 'rows', 'timeline', 'panel'],
    getState: ({ flags }) => ({
      label: flags.feedDebugPanelOpen ? 'On' : 'Off',
      tone: flags.feedDebugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleFeedDebugPanel(),
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
  {
    // Save Debug Logs — one-shot action (not a toggle). Snapshots the
    // focused pane's state/feed-debug/proxy-semantic/HTML into a single
    // timestamped folder under ~/.config/cc-shell/debug-bundles/ and
    // copies the path to the clipboard. Purpose is dev-time
    // diagnostics of cc-shell itself — the four debug panels read the
    // same data live, this command preserves it for after-the-fact
    // inspection.
    //
    // Requires a focused pane (any kind) — the bundle is pane-scoped.
    // Wide keyword net because the user might remember "save", "dump",
    // "export", "snapshot", or the name of any one panel.
    id: 'save-debug-logs',
    title: 'Save Debug Logs',
    keywords: [
      'save',
      'debug',
      'logs',
      'bundle',
      'dump',
      'export',
      'snapshot',
      'proxy',
      'feed',
      'html',
      'diagnostics',
    ],
    when: ({ workspace }) => Boolean(workspace.activeTab),
    run: ({ workspace, ui }) => {
      // closePalette immediately so the toast (which lands in the
      // pane, not the palette) is visible right after trigger.
      ui.closePalette()
      void runSaveDebugBundleCommand(workspace)
    },
  },
  {
    id: 'toggle-html-debug-panel',
    title: 'HTML Debug Panel',
    // Wide keyword net so fuzzy search hits this from likely queries:
    // "html", "dom", "outerhtml", "markup", "inspect", "copy pane".
    // The feature is niche enough that users won't remember its exact
    // title, but they'll remember what they want to do with it.
    keywords: ['html', 'dom', 'outerhtml', 'markup', 'inspect', 'copy', 'pane', 'render', 'debug'],
    getState: ({ flags }) => ({
      label: flags.htmlDebugPanelOpen ? 'On' : 'Off',
      tone: flags.htmlDebugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleHtmlDebugPanel(),
  },
]
