import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { runSaveDebugBundleCommand } from '@renderer/features/debug/saveDebugBundle'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { BuiltInMcpDomain } from '@mcp/shared/types'

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildResumeCommand(kind: 'claude' | 'codex', cwd: string, providerSessionId: string): string {
  const cd = `cd ${shellQuote(cwd)}`
  const resume = kind === 'codex'
    ? `codex resume ${shellQuote(providerSessionId)}`
    : `claude --resume ${shellQuote(providerSessionId)}`
  return `${cd} && ${resume}`
}

function builtInMcpDomainState(
  ctx: CommandContext,
  domain: BuiltInMcpDomain,
): { label: string; tone: 'neutral' | 'accent' } {
  const sessionId = commandTargetSessionId(ctx.workspace)
  const meta = sessionId ? ctx.workspace.state.sessions[sessionId] : null
  const enabled = Boolean(meta?.builtInMcpDomains?.includes(domain))
  return {
    label: enabled ? 'On' : 'Off',
    tone: enabled ? 'accent' : 'neutral',
  }
}

function toggleBuiltInMcpDomain(
  domains: readonly BuiltInMcpDomain[] | undefined,
  domain: BuiltInMcpDomain,
): BuiltInMcpDomain[] {
  // WHY these commands are true toggles even though they reload the agent:
  // the palette badge says On/Off, so the command must honor that contract.
  // Adding a domain requires a provider restart because the MCP server list
  // is fixed at spawn time; disabling one is the same operation in reverse:
  // restart the same provider session with the domain removed.
  const current = domains ?? []
  return current.includes(domain)
    ? current.filter(existing => existing !== domain)
    : Array.from(new Set([...current, domain]))
}

export const sessionCommands: CommandDef[] = [
  {
    id: 'view-prompts',
    surface: 'session',
    title: 'View Prompts',
    description: '**What it does:** Opens prompt history for the focused **agent**.\n\n**Use when:** You want to inspect previous user prompts.\n\n**Notes:** Claude and Codex agents only.',
    keywords: ['prompts', 'history', 'user', 'modal', 'session', 'context'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      ui.openViewPrompts(sessionId)
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
    surface: 'session',
    title: 'Rewind to Prompt…',
    description: '**What it does:** Rewinds the focused **agent session** to an earlier prompt.\n\n**Use when:** You want to branch from a previous point.\n\n**Notes:** The original transcript file is not edited.',
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
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return (
        (kind === 'claude' || kind === 'codex') &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      ui.openRewindPrompt(sessionId)
      ui.closePalette()
    },
  },
  {
    // Undo Rewind — a runtime-only recovery affordance for the most recent
    // Rewind-to-Prompt on the focused pane. This deliberately does NOT share
    // the Undo Close stack: close undo restores tile placement from a LIFO
    // history, while rewind undo swaps provider transcript identity back via
    // replaceSession. The command is visible only while the current pane still
    // points at the rewound provider id; submit-start clearing removes it before
    // the user can create branch work that an undo would hide.
    id: 'undo-rewind',
    surface: 'session',
    title: 'Undo Rewind',
    description: '**What it does:** Restores the focused **agent session** to the provider transcript it used before the last rewind.\n\n**Use when:** You rewound to the wrong prompt and have not submitted new work from the rewound branch.\n\n**Notes:** Runtime-only. Available until the next submit, pane close, or reload.',
    keywords: [
      'undo',
      'rewind',
      'restore',
      'tail',
      'rollback',
      'back',
      'history',
      'prompt',
    ],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const runtime = workspace.getRuntime(sessionId)
      const pending = runtime.pendingRewindUndo
      const kind = meta?.kind ?? 'claude'
      return (
        (kind === 'claude' || kind === 'codex') &&
        Boolean(pending) &&
        meta?.providerSessionId === pending?.rewoundProviderSessionId &&
        !runtime.processActive &&
        !runtime.semantic.currentTurn
      )
    },
    run: async ({ workspace, ui }) => {
      ui.closePalette()
      await workspace.undoLastRewind()
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
    surface: 'app',
    title: 'Agent Activity…',
    description: '**What it does:** Opens an overview of **agent activity** across the workspace.\n\n**Use when:** You want to triage active, idle, or stale agents.\n\n**Notes:** Useful for cleanup during long multi-agent sessions.',
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
    // Close Old Agents — batch cleanup for stale provider panes.
    //
    // WHY this is an app-surface command instead of a session command:
    // the user is cleaning the workspace, not acting on the focused pane.
    // The modal defaults to all projects and then lets the user narrow by
    // cwd, so hiding it when no agent is focused would make exactly the
    // "cleanup the mess from anywhere" use case harder. The modal itself
    // handles the empty workspace case with a preview empty state.
    id: 'close-old-agents',
    surface: 'app',
    title: 'Close Old Agents…',
    description: '**What it does:** Opens a batch cleanup modal for **Claude and Codex agents** inactive longer than a chosen time.\n\n**Use when:** You want to close stale agents across all projects or selected projects.\n\n**Notes:** Defaults to 4 hours and excludes currently-running agents unless you opt in.',
    keywords: [
      'close',
      'old',
      'agents',
      'stale',
      'inactive',
      'idle',
      'cleanup',
      'projects',
      'batch',
      'kill',
    ],
    run: ({ ui }) => {
      ui.openCloseOldAgents()
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
    surface: 'app',
    title: 'Search Conversation Prompts',
    description: '**What it does:** Searches saved conversations by **prompt text**.\n\n**Use when:** You remember what you asked, but not where it was.\n\n**Notes:** Searches sessions on disk, not only visible panes.',
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
    id: 'enable-built-in-mcp-ping',
    // `session`, not `debug`: Ping is diagnostic, but the command still
    // reloads the focused Claude/Codex session and must follow Dispatch
    // row focus exactly like the other built-in MCP toggles. The
    // `devDebugEnabled` check below remains the data/product gate.
    surface: 'session',
    title: 'Built-in MCP Ping',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code built-in MCP ping access on or off.\n\n**Use when:** You want to verify the MCP bridge for this pane.\n\n**Notes:** Ping is a diagnostic MCP domain; orchestration tools are separate.',
    keywords: ['mcp', 'server', 'built-in', 'ping', 'enable', 'disable', 'reload', 'agent', 'claude', 'codex'],
    when: ({ workspace, flags }) => {
      if (!flags.devDebugEnabled) return false
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    getState: ctx => builtInMcpDomainState(ctx, 'ping'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if ((kind !== 'claude' && kind !== 'codex') || !meta) return

      ui.closePalette()
      try {
        const nextDomains = toggleBuiltInMcpDomain(meta.builtInMcpDomains, 'ping')
        const newSessionId = await workspace.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: meta.providerSessionId,
          builtInMcpDomains: nextDomains,
        })
        if (newSessionId) {
          workspace.showPaneToast(
            newSessionId,
            nextDomains.includes('ping')
              ? 'Reloaded with built-in MCP ping'
              : 'Reloaded without built-in MCP ping',
          )
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Built-in MCP reload failed'
        workspace.showPaneToast(sessionId, message)
      }
    },
  },
  {
    id: 'enable-ai-workspace-mcp',
    surface: 'session',
    title: 'AI Workspace MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code AI Workspace MCP tools on or off.\n\n**Use when:** You want this agent to create curated cross-worktree file review workspaces.\n\n**Notes:** Orchestration agents can use this domain, but it remains a separate MCP capability.',
    keywords: ['mcp', 'ai workspace', 'workspace', 'review', 'files', 'worktree', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    getState: ctx => builtInMcpDomainState(ctx, 'ai_workspace'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if ((kind !== 'claude' && kind !== 'codex') || !meta) return

      ui.closePalette()
      try {
        const nextDomains = toggleBuiltInMcpDomain(meta.builtInMcpDomains, 'ai_workspace')
        const newSessionId = await workspace.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: meta.providerSessionId,
          builtInMcpDomains: nextDomains,
        })
        if (newSessionId) {
          workspace.showPaneToast(
            newSessionId,
            nextDomains.includes('ai_workspace')
              ? 'Reloaded with AI Workspace MCP'
              : 'Reloaded without AI Workspace MCP',
          )
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'AI Workspace MCP reload failed'
        workspace.showPaneToast(sessionId, message)
      }
    },
  },
  {
    id: 'enable-orchestration-mcp',
    surface: 'session',
    title: 'Orchestration MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code orchestration MCP tools on or off.\n\n**Use when:** You want this agent to create and coordinate distinct orchestration child agents.\n\n**Notes:** Orchestration agents are separate from manual Linked Agents.',
    keywords: ['mcp', 'orchestration', 'agents', 'workers', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    getState: ctx => builtInMcpDomainState(ctx, 'orchestration'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if ((kind !== 'claude' && kind !== 'codex') || !meta) return

      ui.closePalette()
      try {
        const nextDomains = toggleBuiltInMcpDomain(meta.builtInMcpDomains, 'orchestration')
        const newSessionId = await workspace.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: meta.providerSessionId,
          builtInMcpDomains: nextDomains,
        })
        if (newSessionId) {
          workspace.showPaneToast(
            newSessionId,
            nextDomains.includes('orchestration')
              ? 'Reloaded with orchestration MCP'
              : 'Reloaded without orchestration MCP',
          )
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Orchestration MCP reload failed'
        workspace.showPaneToast(sessionId, message)
      }
    },
  },
  {
    id: 'enable-agent-transcripts-mcp',
    surface: 'session',
    title: 'Agent Transcripts MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code transcript-consumption MCP tools on or off.\n\n**Use when:** You want this agent to read a specific Claude/Codex JSONL transcript file through filtered projections instead of manual shell parsing.\n\n**Notes:** The tool accepts an explicit file path and returns bounded normalized transcript context; it does not discover transcripts for the agent.',
    keywords: ['mcp', 'transcript', 'transcripts', 'agent context', 'handoff', 'review', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    getState: ctx => builtInMcpDomainState(ctx, 'agent_transcripts'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if ((kind !== 'claude' && kind !== 'codex') || !meta) return

      ui.closePalette()
      try {
        const nextDomains = toggleBuiltInMcpDomain(meta.builtInMcpDomains, 'agent_transcripts')
        const newSessionId = await workspace.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: meta.providerSessionId,
          builtInMcpDomains: nextDomains,
        })
        if (newSessionId) {
          workspace.showPaneToast(
            newSessionId,
            nextDomains.includes('agent_transcripts')
              ? 'Reloaded with Agent Transcripts MCP'
              : 'Reloaded without Agent Transcripts MCP',
          )
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Agent Transcripts MCP reload failed'
        workspace.showPaneToast(sessionId, message)
      }
    },
  },
  {
    id: 'reload-agent',
    surface: 'session',
    title: 'Reload Agent',
    description: '**What it does:** Restarts the focused **Claude or Codex agent**.\n\n**Use when:** The agent is stuck, exited, or needs reconnecting.\n\n**Notes:** Requires a resumable provider session.',
    keywords: ['reload', 'resume', 'agent', 'claude', 'codex', 'reconnect'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? 'claude'
      return {
        label: kind === 'codex' ? 'Codex' : 'Claude',
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return (kind === 'claude' || kind === 'codex') && Boolean(meta?.providerSessionId)
    },
    run: ({ workspace }) => void workspace.reloadFocusedAgent(),
  },
  {
    id: 'soft-reload-agent',
    surface: 'session',
    title: 'Soft Reload Agent',
    description: '**What it does:** Refreshes the focused **agent view** without restarting its backend process.\n\n**Use when:** The feed or rendering state looks stale, duplicated, or corrupted while the agent is still working.\n\n**Notes:** Keeps the same session, draft, pane placement, and running process.',
    keywords: [
      'soft',
      'reload',
      'refresh',
      'render',
      'renderer',
      'agent',
      'view',
      'stale',
      'corrupt',
      'feed',
      'repair',
    ],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? 'claude'
      return {
        label: kind === 'codex' ? 'Codex' : 'Claude',
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    run: async ({ workspace, ui }) => {
      ui.closePalette()
      const sessionId = await workspace.softReloadAgentView()
      if (sessionId) workspace.showPaneToast(sessionId, 'Soft reloaded agent view')
    },
  },
  {
    id: 'toggle-agent-terminal-mode',
    surface: 'session',
    title: 'Agent Terminal Mode',
    description: '**What it does:** Switches the focused **Claude or Codex agent** between Agent Code rendering and the provider raw terminal.\n\n**Use when:** The feed, composer, or custom renderer is broken but the underlying provider TUI is still usable.\n\n**Notes:** This is a per-agent recovery view. It keeps the same live provider process.',
    keywords: ['terminal', 'raw', 'tui', 'fallback', 'agent', 'claude', 'codex', 'renderer', 'feed'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const runtime = sessionId ? workspace.getRuntime(sessionId) : null
      const enabled = Boolean(runtime?.agentTerminalMode)
      return {
        label: enabled ? 'On' : 'Off',
        tone: enabled ? 'accent' : 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      ui.closePalette()
      workspace.toggleAgentTerminalMode(sessionId)
    },
  },
  {
    id: 'copy-resume-command',
    surface: 'session',
    title: 'Copy Resume Command',
    description: '**What it does:** Copies a shell command to **resume this session**.\n\n**Use when:** You want to continue the agent outside the app.\n\n**Notes:** Produces a Claude or Codex CLI command.',
    keywords: ['copy', 'resume', 'command', 'terminal', 'cli', 'shell', 'claude', 'codex'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? 'claude'
      return {
        label: kind === 'codex' ? 'Codex' : 'Claude',
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return (kind === 'claude' || kind === 'codex') && Boolean(meta?.providerSessionId)
    },
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if ((kind !== 'claude' && kind !== 'codex') || !meta?.providerSessionId) return

      const command = buildResumeCommand(kind, meta.cwd, meta.providerSessionId)
      ui.closePalette()
      try {
        await navigator.clipboard.writeText(command)
        workspace.showPaneToast(sessionId, `copied resume command · ${command}`, 5000)
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        workspace.showPaneToast(sessionId, `copy failed: ${msg}`, 4000)
      }
    },
  },
  {
    id: 'duplicate-agent',
    surface: 'session',
    title: 'Duplicate Agent',
    description: '**What it does:** Clones the focused **agent session** into a new pane.\n\n**Use when:** You want a parallel branch of the same conversation.\n\n**Notes:** In **Dispatch**, the clone is created as a detached agent.',
    keywords: ['duplicate', 'clone', 'fork', 'copy', 'session', 'agent'],
    when: ({ workspace }) => {
      // Needs a focused agent session that has a providerSessionId
      // — without that id there's nothing on disk to duplicate.
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return (
        (kind === 'claude' || kind === 'codex') &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if (kind !== 'claude' && kind !== 'codex') return
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
    surface: 'session',
    title: 'Switch Provider',
    description: '**What it does:** Switches the focused agent between **Claude** and **Codex**.\n\n**Use when:** You want to continue the same work with another provider.\n\n**Notes:** Saved sessions are translated; empty panes are replaced with a fresh pane of the other provider.',
    keywords: ['provider', 'switch', 'claude', 'codex', 'translate'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? 'claude'
      return {
        label: kind === 'codex' ? 'Codex' : 'Claude',
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      if (!meta) return false
      const kind = meta?.kind ?? 'claude'
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace }) => void workspace.switchFocusedProvider(),
  },
  {
    id: 'toggle-git-bar',
    surface: 'app',
    title: 'Git Bar',
    description: '**What it does:** Shows or hides the **Git** side panel.\n\n**Use when:** You want repository status for the focused project.\n\n**Notes:** Uses the focused command target’s working directory.',
    getState: ({ flags }) => ({
      label: flags.gitBarOpen ? 'On' : 'Off',
      tone: flags.gitBarOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleGitBar(),
  },
  {
    id: 'toggle-debug-panel',
    surface: 'debug',
    title: 'Debug Panel',
    description: '**What it does:** Shows or hides the focused pane’s **debug panel**.\n\n**Use when:** You need low-level pane or runtime state.\n\n**Notes:** Developer-oriented.',
    getState: ({ flags }) => ({
      label: flags.debugPanelOpen ? 'On' : 'Off',
      tone: flags.debugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleDebugPanel(),
  },
  {
    id: 'toggle-feed-debug-panel',
    surface: 'debug',
    title: 'Feed Debug Panel',
    description: '**What it does:** Shows or hides the **feed debug log** panel.\n\n**Use when:** You want render and feed timeline logs.\n\n**Notes:** Developer-oriented.',
    keywords: ['debug', 'logs', 'feed', 'render', 'rows', 'timeline', 'panel'],
    getState: ({ flags }) => ({
      label: flags.feedDebugPanelOpen ? 'On' : 'Off',
      tone: flags.feedDebugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleFeedDebugPanel(),
  },
  {
    id: 'toggle-proxy-debug-panel',
    surface: 'debug',
    title: 'Proxy Debug Panel',
    description: '**What it does:** Shows or hides **proxy/SSE debug** details.\n\n**Use when:** You are debugging streamed provider events.\n\n**Notes:** Most useful when proxy streaming is enabled.',
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
    // timestamped folder under ~/.config/agent-code/debug-bundles/manual/ and
    // copies the path to the clipboard. Purpose is dev-time
    // diagnostics of Agent Code itself — the four debug panels read the
    // same data live, this command preserves it for after-the-fact
    // inspection.
    //
    // Requires a focused pane (any kind) — the bundle is pane-scoped.
    // Wide keyword net because the user might remember "save", "dump",
    // "export", "snapshot", or the name of any one panel.
    id: 'save-debug-logs',
    surface: 'debug',
    title: 'Save Debug Logs',
    description: '**What it does:** Saves a **debug bundle** for the focused pane.\n\n**Use when:** You need a snapshot to inspect or share later.\n\n**Notes:** Copies the saved bundle path after writing it.',
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
    surface: 'debug',
    title: 'HTML Debug Panel',
    description: '**What it does:** Shows or hides rendered **HTML/DOM** inspection.\n\n**Use when:** You need to inspect the exact pane markup.\n\n**Notes:** Developer-oriented.',
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
  {
    id: 'toggle-dev-debug-panel',
    surface: 'debug',
    title: 'Dev Debug Panel',
    description: '**What it does:** Shows or hides the temporary **Dev Debug Panel** module host.\n\n**Use when:** You need a bug-specific workbench for focused runtime state, regex probes, IPC experiments, or other short-lived diagnostics.\n\n**Notes:** Only appears when `AGENT_CODE_DEV_DEBUG=1` is set.',
    keywords: ['dev', 'debug', 'module', 'probe', 'regex', 'headless', 'snapshot', 'temporary'],
    when: ({ flags }) => flags.devDebugEnabled,
    getState: ({ flags }) => ({
      label: flags.devDebugPanelOpen ? 'On' : 'Off',
      tone: flags.devDebugPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleDevDebugPanel(),
  },
]
