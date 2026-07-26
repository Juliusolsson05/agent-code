import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import {
  getProviderFeatures,
  getRendererProviderCapabilities,
} from '@providers/registry.renderer.capabilities'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { runSaveDebugBundleCommand } from '@renderer/features/debug/saveDebugBundle'
import { runAttachRecordingNoteCommand, runToggleSessionRecordingCommand } from '@renderer/features/debug/attachRecordingNote'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { buildProviderResumeCommand } from '@renderer/workspace/providerResumeCommand'
import { providerSupportsBuiltInMcpDomain } from '@mcp/shared/types'
import type { BuiltInMcpDomain } from '@mcp/shared/types'

function targetSupportsBuiltInMcpDomain(
  workspace: CommandContext['workspace'],
  domain: BuiltInMcpDomain,
): boolean {
  // Command visibility must describe the launcher's real capability, not the
  // broad AgentProviderKind union. OpenCode is a valid agent provider but does
  // not inject built-in MCP yet; Workflow MCP is narrower still because Claude
  // owns the equivalent feature natively.
  const sessionId = commandTargetSessionId(workspace)
  if (!sessionId) return false
  const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
  return isAgentProviderKind(kind) && providerSupportsBuiltInMcpDomain(kind, domain)
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

function agentViewOverrideLabel(
  override: 'agent' | 'terminal' | undefined,
): string {
  switch (override) {
    case 'agent':
      return 'Agent'
    case 'terminal':
      return 'Terminal'
    case undefined:
      return 'Default'
  }
}

export const sessionCommands: CommandDef[] = [
  {
    id: 'view-prompts',
    category: 'session',
    surface: 'session',
    title: 'View Prompts',
    description: '**What it does:** Opens prompt history for the focused **agent**.\n\n**Use when:** You want to inspect previous user prompts.\n\n**Notes:** Claude and Codex agents only.',
    keywords: ['prompts', 'history', 'user', 'modal', 'session', 'context'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Driven by the explicit switch EDGE list, not by agent-hood. "Can
      // switch" is meaningless without a destination, and translation is
      // directional — OpenCode has no edge in either direction today.
      return getProviderFeatures(kind).switchTargets.length > 0
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
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Rewind to Prompt…',
    description: '**What it does:** Rewinds the focused **agent session** to an earlier prompt.\n\n**Use when:** You want to branch from a previous point.\n\n**Notes:** The original transcript file is not edited.',
    renderedViewPolicy: { kind: 'opens-rendered-feed' },
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
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Rewind REWRITES session history, so it needs a real transcript
      // adapter — not merely an agent provider. isAgentProviderKind passed for
      // OpenCode, which has no adapter, so the command appeared enabled and
      // then did nothing.
      return (
        getProviderFeatures(kind).transcriptRewind &&
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
    category: 'session',
    pickerVisibility: 'advanced',
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
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return (
        isAgentProviderKind(kind) &&
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
    category: 'workspace-tools',
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
    category: 'workspace-tools',
    pickerVisibility: 'advanced',
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
    // Switch Agents — bulk provider switch for usage-limit escapes.
    //
    // WHY app-surface (not session): like Close Old Agents, the user is acting
    // on a batch across the workspace, not on the focused pane. The modal picks
    // its own direction and scope and previews the affected agents, so it must
    // open even when nothing is focused.
    //
    // This is the ONLY entry point for the feature — both the forward switch
    // and the "return last batch" affordance live inside the modal. There is
    // deliberately no command for the return and no keybind: it's a low-
    // frequency operation, and a second command/keybind would be clutter.
    id: 'switch-agents-provider',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'app',
    title: 'Switch Agents to Another Provider…',
    description: '**What it does:** Opens a modal to move a batch of **Claude/Codex agents** to the other provider at once, and to return the most recent batch.\n\n**Use when:** You hit a usage limit on one provider and want to move agents to the other (then back later).\n\n**Notes:** History is translated; the most recent batch is remembered so you can send it back from the same modal.',
    keywords: [
      'switch',
      'provider',
      'bulk',
      'batch',
      'claude',
      'codex',
      'migrate',
      'move',
      'limit',
      'usage',
      'rate',
      'return',
      'all',
    ],
    run: ({ ui }) => {
      ui.openBulkProviderSwitch()
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
    category: 'workspace-tools',
    pickerVisibility: 'advanced',
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
    category: 'developer',
    pickerVisibility: 'debug',
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
      return targetSupportsBuiltInMcpDomain(workspace, 'ping')
    },
    getState: ctx => builtInMcpDomainState(ctx, 'ping'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // `when` only controls picker visibility; commands remain callable from
      // keybindings/programmatic sites, so the execution boundary repeats the
      // provider capability check before replacing a process.
      if (
        !isAgentProviderKind(kind) ||
        !providerSupportsBuiltInMcpDomain(kind, 'ping') ||
        !meta
      ) return

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
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'AI Workspace MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code AI Workspace MCP tools on or off.\n\n**Use when:** You want this agent to create curated cross-worktree file review workspaces.\n\n**Notes:** Orchestration agents can use this domain, but it remains a separate MCP capability.',
    keywords: ['mcp', 'ai workspace', 'workspace', 'review', 'files', 'worktree', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      return targetSupportsBuiltInMcpDomain(workspace, 'ai_workspace')
    },
    getState: ctx => builtInMcpDomainState(ctx, 'ai_workspace'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // See the ping command: hidden commands can still be invoked outside the
      // picker, so execution must enforce the same provider policy.
      if (
        !isAgentProviderKind(kind) ||
        !providerSupportsBuiltInMcpDomain(kind, 'ai_workspace') ||
        !meta
      ) return

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
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Orchestration MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code orchestration MCP tools on or off.\n\n**Use when:** You want this agent to create and coordinate distinct orchestration child agents.\n\n**Notes:** Orchestration agents are separate from manual Linked Agents.',
    keywords: ['mcp', 'orchestration', 'agents', 'workers', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      return targetSupportsBuiltInMcpDomain(workspace, 'orchestration')
    },
    getState: ctx => builtInMcpDomainState(ctx, 'orchestration'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // See the ping command: hidden commands can still be invoked outside the
      // picker, so execution must enforce the same provider policy.
      if (
        !isAgentProviderKind(kind) ||
        !providerSupportsBuiltInMcpDomain(kind, 'orchestration') ||
        !meta
      ) return

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
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Agent Transcripts MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with Agent Code transcript-consumption MCP tools on or off.\n\n**Use when:** You want this agent to read a specific Claude/Codex JSONL transcript file through filtered projections instead of manual shell parsing.\n\n**Notes:** The tool accepts an explicit file path and returns bounded normalized transcript context; it does not discover transcripts for the agent.',
    keywords: ['mcp', 'transcript', 'transcripts', 'agent context', 'handoff', 'review', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      return targetSupportsBuiltInMcpDomain(workspace, 'agent_transcripts')
    },
    getState: ctx => builtInMcpDomainState(ctx, 'agent_transcripts'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // See the ping command: hidden commands can still be invoked outside the
      // picker, so execution must enforce the same provider policy.
      if (
        !isAgentProviderKind(kind) ||
        !providerSupportsBuiltInMcpDomain(kind, 'agent_transcripts') ||
        !meta
      ) return

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
    id: 'enable-agent-management-mcp',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Agent Management MCP',
    description: '**What it does:** Reloads the focused **Claude or Codex agent** with project-wide Agent Code management tools on or off.\n\n**Use when:** You want this agent to inventory, inspect, prompt, or—only after an explicit user request—close other agents in its project.\n\n**Notes:** Read operations include visible, detached, and buried agents without waking them. Closing has extra authorization and cascade guards.',
    keywords: ['mcp', 'agent management', 'agents', 'project', 'transcripts', 'cleanup', 'prompt', 'close', 'enable', 'disable', 'reload', 'claude', 'codex'],
    when: ({ workspace }) => {
      return targetSupportsBuiltInMcpDomain(workspace, 'agent_management')
    },
    getState: ctx => builtInMcpDomainState(ctx, 'agent_management'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Command visibility is advisory—the command can still be invoked by a
      // keybinding or programmatic caller—so provider policy is repeated at the
      // mutation boundary before we replace a live process.
      if (
        !isAgentProviderKind(kind) ||
        !providerSupportsBuiltInMcpDomain(kind, 'agent_management') ||
        !meta
      ) return

      ui.closePalette()
      try {
        const nextDomains = toggleBuiltInMcpDomain(meta.builtInMcpDomains, 'agent_management')
        const newSessionId = await workspace.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: meta.providerSessionId,
          builtInMcpDomains: nextDomains,
        })
        if (newSessionId) {
          workspace.showPaneToast(
            newSessionId,
            nextDomains.includes('agent_management')
              ? 'Reloaded with Agent Management MCP'
              : 'Reloaded without Agent Management MCP',
          )
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Agent Management MCP reload failed'
        workspace.showPaneToast(sessionId, message)
      }
    },
  },
  {
    id: 'enable-workflow-mcp',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Workflow MCP',
    description: '**What it does:** Reloads the focused **Codex agent** with Agent Code workflow MCP tools on or off.\n\n**Use when:** You want Codex to discover, start, inspect, cancel, or resume portable multi-agent workflows.\n\n**Notes:** Claude is intentionally excluded because it has a native workflow feature. Workflow execution is app-owned and survives renderer reloads; changing MCP capabilities still requires replacing the provider process.',
    keywords: ['mcp', 'workflow', 'workflows', 'pipeline', 'agents', 'resume', 'enable', 'disable', 'reload', 'codex', 'claude native'],
    when: ({ workspace }) => {
      return targetSupportsBuiltInMcpDomain(workspace, 'workflows')
    },
    getState: ctx => builtInMcpDomainState(ctx, 'workflows'),
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      if (
        !isAgentProviderKind(kind) ||
        !providerSupportsBuiltInMcpDomain(kind, 'workflows') ||
        !meta
      ) return

      ui.closePalette()
      try {
        const nextDomains = toggleBuiltInMcpDomain(meta.builtInMcpDomains, 'workflows')
        // WHY replace the agent instead of mutating the running registration:
        // Codex receives its MCP configuration at process launch. Updating
        // renderer metadata alone would display an enabled toggle while the
        // provider still had a cached tools/list response from the old scope.
        // Replacement keeps visible state and actual capability atomic.
        const newSessionId = await workspace.replaceSession(meta.cwd, {
          kind,
          resumeSessionId: meta.providerSessionId,
          builtInMcpDomains: nextDomains,
        })
        if (newSessionId) {
          workspace.showPaneToast(
            newSessionId,
            nextDomains.includes('workflows')
              ? 'Reloaded with Workflow MCP'
              : 'Reloaded without Workflow MCP',
          )
        }
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Workflow MCP reload failed'
        workspace.showPaneToast(sessionId, message)
      }
    },
  },
  {
    id: 'reload-agent',
    category: 'session',
    surface: 'session',
    title: 'Reload Agent',
    description: '**What it does:** Restarts the focused **Claude or Codex agent**.\n\n**Use when:** The agent is stuck, exited, or needs reconnecting.\n\n**Notes:** Requires a resumable provider session.',
    keywords: ['reload', 'resume', 'agent', 'claude', 'codex', 'reconnect'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return {
        label: getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER).shortLabel,
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Requires a VERIFIED external resume form. An unverified template hands
      // the user a shell command that may not work, which is worse than not
      // offering it — they paste it into a terminal and blame their setup.
      return (
        getProviderFeatures(kind).verifiedExternalResumeCommand &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: ({ workspace }) => void workspace.reloadFocusedAgent(),
  },
  {
    id: 'soft-reload-agent',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Soft Reload Agent',
    description: '**What it does:** Refreshes the focused **agent view** without restarting its backend process.\n\n**Use when:** The feed or rendering state looks stale, duplicated, or corrupted while the agent is still working.\n\n**Notes:** Keeps the same session, draft, pane placement, and running process.',
    renderedViewPolicy: { kind: 'requires-rendered-feed' },
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
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return {
        label: getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER).shortLabel,
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return isAgentProviderKind(kind)
    },
    run: async ({ workspace, ui }) => {
      ui.closePalette()
      const sessionId = await workspace.softReloadAgentView()
      if (sessionId) workspace.showPaneToast(sessionId, 'Soft reloaded agent view')
    },
  },
  {
    id: 'set-agent-view-mode',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Set Agent View Mode...',
    description: '**What it does:** Overrides the focused agent pane to use Agent rendering, Terminal rendering, or the global default.\n\n**Use when:** One session needs the raw provider terminal while the rest of the app keeps its normal view mode.\n\n**Notes:** Persists with the session. Hybrid remains a global/default setting, not a per-session override.',
    keywords: ['agent', 'view', 'mode', 'terminal', 'rendering', 'raw', 'override', 'default'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      return {
        label: agentViewOverrideLabel(meta?.agentViewModeOverride),
        tone: meta?.agentViewModeOverride ? 'accent' : 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
      return isAgentProviderKind(kind)
    },
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      ui.closePalette()
      ui.openAgentViewModePicker(sessionId)
    },
  },
  {
    id: 'copy-resume-command',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Copy Resume Command',
    description: '**What it does:** Copies a shell command to **resume this session**.\n\n**Use when:** You want to continue the agent outside the app.\n\n**Notes:** Produces a Claude or Codex CLI command.',
    keywords: ['copy', 'resume', 'command', 'terminal', 'cli', 'shell', 'claude', 'codex'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return {
        label: getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER).shortLabel,
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return isAgentProviderKind(kind) && Boolean(meta?.providerSessionId)
    },
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Registry-driven runtime narrow — must match the `when` predicate
      // above so a command that visibly enabled doesn't silently no-op on
      // OpenCode. `buildProviderResumeCommand` already accepts any
      // AgentProviderKind and pulls the CLI shape from the registry identity
      // descriptor (#394 phase 2c-2), so no downstream change is needed.
      if (!isAgentProviderKind(kind) || !meta?.providerSessionId) return

      const command = buildProviderResumeCommand(kind, meta.cwd, meta.providerSessionId)
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
    category: 'create',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Duplicate Agent',
    description: '**What it does:** Clones the focused **agent session** into a new pane.\n\n**Use when:** You want a parallel branch of the same conversation.\n\n**Notes:** In **Dispatch**, the clone is created as a detached agent.',
    keywords: ['duplicate', 'clone', 'fork', 'copy', 'session', 'agent'],
    when: ({ workspace }) => {
      // Needs a providerSessionId (something on disk to duplicate) AND a
      // transcript adapter able to project it into a new session. Agent-hood
      // alone proves neither.
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return (
        getProviderFeatures(kind).transcriptDuplicate &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Registry-driven runtime narrow — mirrors the `when` predicate. The old
      // two-provider literal here was the exact reason "Duplicate Agent"
      // silently no-op'd on OpenCode panes even after Phase 7 landed the
      // provider. `duplicateSession`'s preload/main handler already takes
      // `provider: AgentProviderKind` (src/preload/api/provider.ts:50), so the
      // downstream path fans out through the registry — nothing else changes.
      if (!isAgentProviderKind(kind) || !meta?.providerSessionId) return
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
        // WHY the capability domains travel with the transcript clone: built-in MCP credentials
        // are deliberately ephemeral, but the user's decision to enable a domain is durable pane
        // metadata. Passing only the new provider transcript id created a clone that worked until
        // restart, then rehydrate had no domain names from which to mint a fresh project-scoped
        // token. The clone must inherit domain NAMES, never the source session's bearer token.
        await workspace.splitFocused(
          'vertical',
          kind,
          {
            resumeSessionId: newProviderSessionId,
            builtInMcpDomains: meta.builtInMcpDomains,
            // WHY cwd is part of the continuation payload: command targeting may resolve a
            // related/orchestration child displayed inside a parent pane. That child's transcript
            // and MCP domains must be re-registered against the CHILD worktree, not whichever
            // physical pane happens to host its UI.
            cwd: meta.cwd,
          },
        )
      } catch (err) {
        // Surface the failure as a pane toast, not just console.warn — an
        // OpenCode pane hitting `duplicateSession`'s fail-loud throw (see
        // src/main/providerSwitch/duplicateSession.ts) now produces a visible
        // "no duplicate implementation for provider 'opencode' yet" message
        // instead of silently doing nothing. Any other transport / fs error
        // surfaces the same way. Console line is retained for triage.
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Duplicate agent failed'
        workspace.showPaneToast(sessionId, message)
        // eslint-disable-next-line no-console
        console.warn('[duplicate-agent] failed', err)
      }
    },
  },
  {
    id: 'switch-provider',
    category: 'session',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Switch Provider',
    description: '**What it does:** Switches the focused agent between **Claude** and **Codex**.\n\n**Use when:** You want to continue the same work with another provider.\n\n**Notes:** Saved sessions are translated; empty panes are replaced with a fresh pane of the other provider.',
    keywords: ['provider', 'switch', 'claude', 'codex', 'translate'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return {
        label: getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER).shortLabel,
        tone: 'neutral',
      }
    },
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      if (!meta) return false
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return isAgentProviderKind(kind)
    },
    run: ({ workspace }) => void workspace.switchFocusedProvider(),
  },
  {
    id: 'toggle-git-bar',
    category: 'workspace-tools',
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
    category: 'developer',
    pickerVisibility: 'debug',
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
    category: 'developer',
    pickerVisibility: 'debug',
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
    category: 'developer',
    pickerVisibility: 'debug',
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
    category: 'developer',
    pickerVisibility: 'debug',
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
    // Start / Stop Session Recording (plan §7 — the PRIMARY control).
    // Recording is command-driven per session: nothing is written to disk
    // until the operator starts a specific pane, so a day of work never
    // silently fills tens of GB. The env flag AGENT_CODE_SESSION_RECORD is
    // only an optional auto-start power path for unattended soak.
    //
    // The label stays a static "Toggle Session Recording": there is no per-pane
    // active-recording signal plumbed into command state, so we deliberately do
    // NOT implement getState here. A live Start↔Stop label would need an async
    // IPC read (record-session:is-recording) cached into command state and
    // refreshed on palette open — future work, not built yet. Gated on the
    // capability flag (sessionRecordingEnabled == dev-debug on) so it appears
    // whenever the feature is available; the agent-kind guard below keeps it off
    // terminal panes the recorder can't capture.
    id: 'toggle-session-recording',
    category: 'developer',
    pickerVisibility: 'debug',
    surface: 'debug',
    title: 'Toggle Session Recording',
    description: '**What it does:** Starts or stops **continuous recording** of the focused pane\'s rendering-input stream (replayable in the test suite).\n\n**Use when:** Right before reproducing a rendering bug you want captured as a fixture.\n\n**Notes:** Command-driven — nothing records until you start it. Each recording is its own folder under `session-recordings/`.',
    keywords: ['recording', 'record', 'start', 'stop', 'capture', 'session', 'soak', 'fixture', 'debug'],
    when: ({ flags, workspace }) => {
      if (!flags.sessionRecordingEnabled) return false
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      // Agent-kind guard: the recorder only taps the `session:*` feed channels
      // an agent pane emits (SessionRecorderManager RECORDED_CHANNELS). A
      // terminal pane produces raw PTY bytes on other channels, so a recording
      // started against one would capture nothing — hide the command there.
      const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
      return isAgentProviderKind(kind)
    },
    run: ({ workspace, ui }) => {
      ui.closePalette()
      void runToggleSessionRecordingCommand(workspace)
    },
  },
  {
    // Attach Recording Note (plan §7b). The recording-era "save debug logs":
    // drops a timestamped bookmark into the LIVE session recording so a soak
    // operator can flag the exact tick they reacted to without stopping the
    // session. reserve-first (in runAttachRecordingNoteCommand) pins the
    // reaction moment before the input even opens.
    //
    // Gated on flags.sessionRecordingEnabled (== the recording CAPABILITY,
    // dev-debug on): the command appears whenever the feature is available.
    // The "is a recording active for THIS pane" refinement is
    // enforced at run time: reserveRecordingNote returns null and the command
    // toasts "no active recording" rather than pre-computing per-session
    // recorder state into the palette flags on every keystroke.
    id: 'attach-recording-note',
    category: 'developer',
    pickerVisibility: 'debug',
    surface: 'debug',
    title: 'Attach Recording Note',
    description: '**What it does:** Drops a **timestamped note** into the focused pane\'s live session recording.\n\n**Use when:** You see a rendering bug during a recorded soak and want to mark the exact moment.\n\n**Notes:** Reserves the tick instantly, then prompts for text. Only available when session recording is enabled.',
    keywords: ['recording', 'note', 'mark', 'bookmark', 'annotate', 'soak', 'session', 'record', 'tick', 'debug'],
    when: ({ flags, workspace }) => {
      if (!flags.sessionRecordingEnabled) return false
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      // Agent-kind guard, same reason as toggle-session-recording above: only
      // agent panes feed the recorder, so annotating a terminal pane's
      // (non-existent) recording is meaningless — keep the command off them.
      const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
      return isAgentProviderKind(kind)
    },
    run: ({ workspace, ui }) => {
      ui.closePalette()
      void runAttachRecordingNoteCommand(workspace)
    },
  },
  {
    id: 'toggle-rendering-debug-mode',
    category: 'developer',
    pickerVisibility: 'debug',
    surface: 'debug',
    title: 'Rendering Debug Mode',
    description: '**What it does:** Lets you click rendered feed elements to inspect their exact input, routing provenance, and HTML.\n\n**Use when:** A row is missing, duplicated, misleading, or formatted incorrectly.\n\n**Notes:** Clicks are intercepted while active; toggle the mode off to restore normal interaction.',
    keywords: ['rendering', 'renderer', 'inspect', 'element', 'html', 'input', 'receipt', 'routing', 'provenance', 'debug'],
    getState: ({ flags }) => ({
      label: flags.renderingDebugMode ? 'On' : 'Off',
      tone: flags.renderingDebugMode ? 'danger' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleRenderingDebugMode(),
  },
  {
    id: 'toggle-html-debug-panel',
    category: 'developer',
    pickerVisibility: 'debug',
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
    category: 'developer',
    pickerVisibility: 'debug',
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
