import { commandTarget } from '@renderer/features/command-palette/commandTarget'
import { clonedMcpOverrides } from '@renderer/workspace/mcpDomains'
import { DEFAULT_PROVIDER, effectiveProviderRuntime, isAgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'
import { panel, status, toggle, value } from '@renderer/features/command-palette/commandState'
import type {
  CommandContext,
  CommandDef,
  CommandState,
} from '@renderer/features/command-palette/types'
import { runSaveDebugBundleCommand } from '@renderer/features/debug/saveDebugBundle'
import { runAttachRecordingNoteCommand, runToggleSessionRecordingCommand } from '@renderer/features/debug/attachRecordingNote'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { buildProviderResumeCommand } from '@renderer/workspace/providerResumeCommand'
import { providerSupportsBuiltInMcpDomain } from '@mcp/shared/types'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import { clearAgentComposer } from '@renderer/workspace/tile-tree/TileLeaf/clearAgentComposer'
import { hasOrchestrationAgents } from '@renderer/workspace/idleOrchestrationAgents'
import { hasGoalReportingAgents } from '@renderer/workspace/completedGoalAgents'
import { sessionHasTranscript } from '@renderer/workspace/transcriptAvailability'
import {
  reloadSessionWithBuiltInMcpChoice,
} from '@renderer/workspace/builtInMcpReload'
import {
  ROOT_MANAGEMENT_DOMAIN,
  rootManagementReloadLabels,
} from '@renderer/features/workspace/lib/rootManagement'

function targetSupportsBuiltInMcpDomain(
  workspace: CommandContext['workspace'],
  domain: BuiltInMcpDomain,
): boolean {
  // Command visibility must describe the launcher's real capability, not the
  // broad AgentProviderKind union. OpenCode now injects the same process-local
  // endpoints into both runtimes; Workflow MCP remains narrower because Claude
  // owns the equivalent feature natively.
  const sessionId = commandTargetSessionId(workspace)
  if (!sessionId) return false
  const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
  return isAgentProviderKind(kind) && providerSupportsBuiltInMcpDomain(kind, domain)
}

function builtInMcpDomainState(
  ctx: CommandContext,
  domain: BuiltInMcpDomain,
): CommandState {
  const sessionId = commandTargetSessionId(ctx.workspace)
  const meta = sessionId ? ctx.workspace.state.sessions[sessionId] : null
  const enabled = Boolean(meta?.builtInMcpDomains?.includes(domain))
  return toggle(enabled)
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
    description: '**What it does:** Opens prompt history for the focused **agent**.\n\n**Use when:** You want to inspect previous user prompts.\n\n**Notes:** Available for providers with transcript parsing support.',
    keywords: ['prompts', 'history', 'user', 'modal', 'session', 'context'],
    when: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Needs the transcript parser to RECOGNIZE this provider's user prompts.
      // This guard was `switchTargets.length > 0` — the Switch Provider
      // predicate, transposed here. It happened to hide the same providers, so
      // nothing looked wrong; it would have started reporting the wrong answer
      // the moment a switch edge was added for a provider whose prompts we
      // cannot parse, or an adapter for one with no switch edge.
      //
      // sessionHasTranscript keeps plain terminals out (no entries to extract
      // from). OpenCode Terminal passes it since #971: #882's Stage 6 loads
      // its history into `runtime.entries`, so prompt extraction reads real
      // prompts — the modal opens over the TUI pane and mounts nothing on it.
      return getProviderFeatures(kind).promptHistoryExtraction && sessionHasTranscript(meta)
    },
    run: ({ workspace, ui, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      ui.openViewPrompts(sessionId)
    },
    contextMenu: { group: 'agent', order: 60, title: 'View Prompts…' },
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
    // Requires a focused transcript-backed agent with a providerSessionId
    // — rewind needs a file on disk to truncate from. The action
    // itself re-checks and surfaces a toast if the pane is
    // mid-stream.
    id: 'rewind-to-prompt',
    category: 'session',
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.

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
    when: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Rewind REWRITES session history, so it needs a real transcript
      // adapter — not merely an agent provider. This explicit feature gate was
      // introduced when OpenCode had no adapter; retaining it matters because
      // the next provider must not inherit destructive transcript powers just
      // by joining the broad agent-kind union.
      //
      // WHY a native terminal runtime (OpenCode Terminal, the only one today)
      // stays excluded although OpenCode supports rewind: rewind hands the
      // anchored prompt back as the pane's COMPOSER draft
      // (rewindSessionToPrompt → draftInput), and a native TUI pane renders
      // no composer; the TUI owns its own input box. The rewound prompt would
      // land in a runtime field nothing shows. Supporting it means delivering
      // that draft into the TUI's input, and respawning the TUI on the
      // rewritten session through replaceSession. That second half USED to be
      // a blocker of its own — replaceSession dropped a child's orchestration
      // metadata, so a rewound terminal child fell out of its run — and #879
      // closed it: the successor now carries its relationships. What remains
      // is the composer half above. A follow-up feature (#896), not a gate to
      // lift.
      return (
        getProviderFeatures(kind).transcriptRewind &&
        // Effective: a terminal-only provider (Pi) has no composer to receive
        // the rewound draft even when its metadata carries no runtime.
        effectiveProviderRuntime(kind, meta?.providerRuntime) !== 'terminal' &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: ({ workspace, ui, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      ui.openRewindPrompt(sessionId)
      ui.closePalette()
    },
    contextMenu: { group: 'agent', order: 50 },
  },
  {
    // Remove Cybersecurity Block — Codex-only recovery that forks the
    // focused rollout and drops the last model step after a
    // cyber_policy task_complete. Rewind to Prompt also unblocks, but
    // it deletes the last user prompt and the whole assistant turn.
    // This command keeps that turn minus the tail that the next API
    // request would resend. The source file is never edited.
    id: 'remove-cybersecurity-block',
    category: 'session',
    surface: 'session',
    title: 'Remove Cybersecurity Block',
    description: '**What it does:** Forks the focused **Codex** session with the last model step after a cybersecurity block removed.\n\n**Use when:** Codex ended the turn with a cybersecurity flag and you want to keep chatting without Rewind to Prompt deleting the whole assistant response.\n\n**Notes:** The original transcript is not edited. Undo Rewind restores it until the next submit.',
    renderedViewPolicy: { kind: 'opens-rendered-feed' },
    keywords: [
      'cyber',
      'cybersecurity',
      'security',
      'block',
      'flag',
      'policy',
      'codex',
      'remove',
      'unblock',
      'safety',
    ],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return (
        kind === 'codex' &&
        getProviderFeatures(kind).transcriptRewind &&
        meta?.providerRuntime !== 'terminal' &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: async ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      // Match `when` exactly so a keybinding cannot strip a Claude pane, a
      // provider that lost transcriptRewind, or a native terminal runtime.
      // Codex has no terminal runtime today (only OpenCode does, and the kind
      // check already excludes it); the runtime check is there so this
      // opens-rendered-feed command cannot reach a Codex native TUI if one is
      // ever added, since that pane would not render the rewritten feed.
      if (
        meta?.kind !== 'codex' ||
        !getProviderFeatures(meta.kind).transcriptRewind ||
        meta.providerRuntime === 'terminal' ||
        !meta.providerSessionId
      ) return
      ui.closePalette()
      await workspace.removeFocusedCyberPolicyBlock()
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
    description: '**What it does:** Restores the focused **agent session** to the provider transcript it used before the last Rewind to Prompt or Remove Cybersecurity Block.\n\n**Use when:** You rewound or stripped a cybersecurity block and have not submitted new work from that branch.\n\n**Notes:** Runtime-only. Available until the next submit, pane close, or reload.',
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
    // Agent Activity — full-screen view of every agent in the window, lane or
    // pool, sectioned by what it needs (#1170): needs you / working / idle /
    // exited. Always available: it needs nothing focused, and it reads the
    // fleet's notes only while it is open.
    id: 'open-agent-activity',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Open Agent Activity…',
    description: '**What it does:** Opens a full-screen view of **every agent**, grouped into Needs you, Working, Idle and Exited.\n\n**Use when:** You want to see which agent is waiting for you, what the others are doing, or close several idle ones at once.\n\n**Notes:** Type to filter, Space to select, ⌫ to close. Close Old Agents and Close Idle Orchestration Agents stay as quick one-shot commands.',
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
    getState: ({ flags }) => panel(flags.agentActivityOpen),
    run: ({ ui, flags }) => {
      if (flags.agentActivityOpen) {
        ui.closeAgentActivity()
        return
      }
      ui.openAgentActivity()
      ui.closePalette()
    },
  },
  {
    // Close Old Agents — batch cleanup for stale agent AND terminal panes
    // (#865 gave Close Old Agents parity: terminals are inactive-sortable
    // and closeable through this same batch flow, not just agents).
    //
    // WHY this is an app-surface command instead of a session command:
    // the user is cleaning the workspace, not acting on the focused pane.
    // The modal defaults to all projects and then lets the user narrow by
    // cwd, so hiding it when no agent is focused would make exactly the
    // "cleanup the mess from anywhere" use case harder. The modal itself
    // handles the empty workspace case with a preview empty state.
    id: 'close-old-agents',
    category: 'workspace-tools',
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.

    surface: 'app',
    title: 'Close Old Agents…',
    description: '**What it does:** Opens a batch cleanup modal for **agents and terminals** inactive longer than a chosen time.\n\n**Use when:** You want to close stale agents and terminals across all projects or selected projects.\n\n**Notes:** Defaults to 4 hours and excludes currently-running sessions unless you opt in.',
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
    getState: ({ flags }) => panel(flags.closeOldAgentsOpen),
    run: ({ ui, flags }) => {
      if (flags.closeOldAgentsOpen) {
        ui.closeCloseOldAgents()
        return
      }
      ui.openCloseOldAgents()
      ui.closePalette()
    },
  },
  {
    // Close Idle Orchestration Agents (#960) — the end of an orchestration run
    // whose parent never called close_run: every worker that has finished and
    // is idle, across the window, after one confirmation listing them.
    //
    // WHY app-surface: like Close Old Agents, this cleans the workspace rather
    // than acting on the focused pane, and the workers are usually Dispatch
    // rows the user is not looking at.
    //
    // WHY no ellipsis although a dialog opens: the dialog confirms, it asks for
    // no further input (docs/command-style.md rule 8), the same shape as Close
    // Tab.
    //
    // WHY the default picker tier while Close Old Agents is `advanced`:
    // `advanced` hides a command from the palette until the user reveals hidden
    // commands, and this is the everyday end of an orchestration run rather
    // than niche maintenance.
    id: 'close-idle-orchestration-agents',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Close Idle Orchestration Agents',
    description: '**What it does:** Closes every **orchestration agent** that has finished its work and is idle, after confirming the list.\n\n**Use when:** An orchestration run left finished workers parked in the pool.\n\n**Notes:** Working, starting, exited and failed agents stay open, and so do the agents that started them.',
    keywords: [
      'close',
      'idle',
      'orchestration',
      'orchestrated',
      'workers',
      'children',
      'finished',
      'done',
      'cleanup',
      'dispatch',
      'batch',
    ],
    when: ({ workspace }) => hasOrchestrationAgents(workspace.state),
    run: async ({ workspace, ui }) => {
      // Before the dialog opens, so the confirmation is not layered under the
      // palette.
      ui.closePalette()
      await workspace.closeIdleOrchestrationAgents()
    },
  },
  {
    // #1182. The payoff of goal_complete: one agent per feature, the PR
    // merges, the agent says so, and this closes every finished one in one
    // pass. A modal rather than the confirm dialog Close Idle Orchestration
    // Agents uses, because the user picks which to keep and whether their
    // lanes go too — a yes/no dialog cannot hold either choice. Hence the
    // ellipsis: more input follows the invocation.
    id: 'close-completed-agents',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Close Completed Agents…',
    description: '**What it does:** Lists every **agent whose goal is complete** across all projects and closes the ones you keep ticked, optionally removing their lanes.\n\n**Use when:** Agents finished their features (for example the PRs merged) and are still sitting in lanes.\n\n**Notes:** Agents mark their goal complete through Goal MCP once you have accepted the work. Running agents stay open. Setting a new goal clears the completion.',
    keywords: [
      'close',
      'completed',
      'complete',
      'done',
      'finished',
      'goal',
      'merged',
      'cleanup',
      'lanes',
      'batch',
    ],
    when: ({ workspace }) => hasGoalReportingAgents(workspace.state),
    getState: ({ flags }) => panel(flags.closeCompletedAgentsOpen),
    run: ({ ui, flags }) => {
      if (flags.closeCompletedAgentsOpen) {
        ui.closeCloseCompletedAgents()
        return
      }
      ui.openCloseCompletedAgents()
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
    surface: 'app',
    title: 'Switch Agents to Another Provider…',
    description: '**What it does:** Opens a modal to move a batch of agents between **providers** — the destinations each provider declares, which today include Claude, Codex, OpenCode and Grok — and to return the most recent batch.\n\n**Use when:** You hit a usage limit on one provider and want to move agents elsewhere (then back later).\n\n**Notes:** History is translated; the most recent batch is remembered so you can send it back from the same modal.',
    keywords: [
      'switch',
      'provider',
      'bulk',
      'batch',
      'claude',
      'codex',
      'opencode',
      'migrate',
      'move',
      'limit',
      'usage',
      'rate',
      'return',
      'all',
    ],
    getState: ({ flags }) => panel(flags.bulkProviderSwitchOpen),
    run: ({ ui, flags }) => {
      if (flags.bulkProviderSwitchOpen) {
        ui.closeBulkProviderSwitch()
        return
      }
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
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.

    surface: 'app',
    title: 'Search Conversations…',
    description: '**What it does:** Finds a past conversation by **title, name or prompt text** across every worktree of this repository and all providers.\n\n**Use when:** You remember what you asked or what it was called, but not where it was.\n\n**Notes:** Same picker as Resume Session…, opened with the search field focused.',
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
      'resume',
    ],
    getState: ({ flags }) => panel(flags.conversationsOpen),
    run: ({ ui, flags }) => {
      if (flags.conversationsOpen) {
        ui.closeConversations()
        return
      }
      ui.openConversations({ focusSearch: true })
      ui.closePalette()
    },
  },
  {
    id: 'enable-built-in-mcp-ping',
    category: 'developer',
    pickerVisibility: 'debug',
    // `session`, not `debug`: Ping is diagnostic, but the command still
    // reloads the focused agent session and must follow Dispatch
    // row focus exactly like the other built-in MCP toggles. The
    // `devDebugEnabled` check below remains the data/product gate.
    surface: 'session',
    title: 'Built-in MCP Ping',
    description: '**What it does:** Reloads the focused **agent** with Agent Code built-in MCP ping access on or off.\n\n**Use when:** You want to verify the MCP bridge for this pane.\n\n**Notes:** Ping is a diagnostic MCP domain; orchestration tools are separate.',
    keywords: ['mcp', 'server', 'built-in', 'ping', 'enable', 'disable', 'reload', 'agent', 'claude', 'codex', 'opencode'],
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
      const enable = !meta.builtInMcpDomains?.includes('ping')
      await reloadSessionWithBuiltInMcpChoice(workspace, sessionId, 'ping', enable, {
        reloaded: enable ? 'Reloaded with built-in MCP ping' : 'Reloaded without built-in MCP ping',
        failed: 'Built-in MCP reload failed',
      })
    },
  },
  {
    id: 'enable-root-agent-code-management',
    category: 'session',
    surface: 'session',
    risk: 'destructive',
    title: 'Root Agent Code Management',
    description: '**What it does:** Gives the focused **agent** application-wide control of Agent Code: every window, project, agent, terminal and layout, through the same tools an external operator uses.\n\n**Use when:** You are supervising one specific, rare job, such as reorganizing the workspace right after this agent audited every other agent.\n\n**Notes:** Off by default and never a Settings default. Turning it on asks you to confirm first and then reloads the agent; turning it off reloads without the tools and asks nothing.',
    keywords: ['root', 'agent code management', 'operator', 'control', 'mcp', 'workspace', 'layout', 'reorganize', 'all projects', 'enable', 'disable', 'reload', 'claude', 'codex', 'opencode'],
    when: ({ workspace }) => {
      return targetSupportsBuiltInMcpDomain(workspace, ROOT_MANAGEMENT_DOMAIN)
    },
    getState: ctx => builtInMcpDomainState(ctx, ROOT_MANAGEMENT_DOMAIN),
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
        !providerSupportsBuiltInMcpDomain(kind, ROOT_MANAGEMENT_DOMAIN) ||
        !meta
      ) return

      ui.closePalette()
      const enabled = Boolean(meta.builtInMcpDomains?.includes(ROOT_MANAGEMENT_DOMAIN))
      if (enabled) {
        // Revoking needs no ceremony: the reload simply drops the domain.
        await reloadSessionWithBuiltInMcpChoice(
          workspace,
          sessionId,
          ROOT_MANAGEMENT_DOMAIN,
          false,
          rootManagementReloadLabels(false),
        )
        return
      }
      // WHY the command does NOT reload here: granting application-wide
      // control is the one MCP toggle whose blast radius reaches beyond the
      // agent's own project. The confirmation dialog owns the enable path
      // (RootManagementConfirmSurface), so a declined warning leaves the
      // session exactly as it was, and the target is captured now rather than
      // re-read after the user finishes reading.
      ui.openRootManagementPrompt(sessionId)
    },
  },
  {
    id: 'reload-agent',
    category: 'session',
    surface: 'session',
    title: 'Reload Agent',
    description: '**What it does:** Restarts the focused **agent**.\n\n**Use when:** The agent is stuck, exited, or needs reconnecting.\n\n**Notes:** Requires a resumable provider session.',
    keywords: ['reload', 'resume', 'agent', 'claude', 'codex', 'opencode', 'pi', 'reconnect'],
    getState: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // The provider name is CONTEXT — which provider this command would act on —
      // not an enabled state. Styled with accent tone it read as a live toggle.
      return value(
        getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER)
          .shortLabel,
      )
    },
    when: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Reload respawns the session THROUGH US with a resume id; it never
      // hands the user a shell string. Gating it on
      // `verifiedExternalResumeCommand` was the wrong flag in the direction
      // that costs a working feature: OpenCode replays history on resume just
      // fine, and this guard hid the command for it anyway.
      return (
        getProviderFeatures(kind).inAppResume &&
        Boolean(meta?.providerSessionId)
      )
    },
    // reloadSessionAgent with the resolved id, not reloadFocusedAgent: the
    // Focused wrapper re-resolves focus, which would reload the focused lane's
    // agent instead of the right-clicked row (#1180). For the palette the two
    // are identical — the wrapper is exactly this call with the focused id.
    run: async ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
      const result = await workspace.reloadSessionAgent(sessionId)
      // Re-report the outcome for a targeted (Sessions row menu) reload.
      // reloadSessionAgent toasts through the `showPaneToast` captured inside
      // its hook, which the menu's off-screen wrapper (targetedCommandContext)
      // cannot intercept — so reloading an agent in no lane succeeded or
      // FAILED with no visible word (#1180 review). Repeating the same text
      // through `workspace.showPaneToast` rewrites the identical pane toast
      // (single slot) and adds the global one while the agent is off screen.
      // The palette path needs none of this: its target is on screen.
      if (target === undefined) return
      if (result.status === 'completed') {
        const label = getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER).shortLabel
        workspace.showPaneToast(result.newSessionId, `${label} reloaded`)
      } else {
        workspace.showPaneToast(sessionId, result.status === 'failed' ? result.message : result.reason)
      }
    },
    contextMenu: { group: 'agent', order: 10 },
  },
  {
    id: 'soft-reload-agent',
    category: 'session',
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
      // The provider name is CONTEXT — which provider this command would act on —
      // not an enabled state. Styled with accent tone it read as a live toggle.
      return value(
        getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER)
          .shortLabel,
      )
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
    surface: 'session',
    title: 'Agent View for This Session…',
    description: '**What it does:** Overrides the focused agent pane to use Agent rendering, Terminal rendering, or the global default.\n\n**Use when:** One session needs the raw provider terminal while the rest of the app keeps its normal view mode.\n\n**Notes:** Persists with the session. Hybrid remains a global/default setting, not a per-session override.',
    keywords: ['agent', 'view', 'mode', 'terminal', 'rendering', 'raw', 'override', 'default', 'set agent view mode'],
    getState: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      // A selected option out of Default/Agent/Terminal. Not a toggle:
      // "Default" is a real third choice, not the absence of a state.
      return value(agentViewOverrideLabel(meta?.agentViewModeOverride))
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
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.

    surface: 'session',
    title: 'Copy Resume Command',
    description: '**What it does:** Copies a shell command to **resume this session**.\n\n**Use when:** You want to continue the agent outside the app.\n\n**Notes:** Produces the current provider’s verified CLI command.',
    keywords: ['copy', 'resume', 'command', 'terminal', 'cli', 'shell', 'claude', 'codex', 'opencode', 'pi'],
    getState: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // The provider name is CONTEXT — which provider this command would act on —
      // not an enabled state. Styled with accent tone it read as a live toggle.
      return value(
        getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER)
          .shortLabel,
      )
    },
    when: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // The ONE command the verified-template flag is actually about: this
      // produces a string the user pastes into their own terminal. An
      // unverified template is worse than an absent command, because it fails
      // in their shell and they blame their setup. Agent-hood proved nothing
      // here — it is what offered OpenCode a guessed `opencode --resume` form.
      return (
        getProviderFeatures(kind).verifiedExternalResumeCommand &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: async ({ workspace, ui, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Runtime narrow mirroring the `when` predicate exactly, so a command
      // that renders enabled cannot silently no-op.
      if (!getProviderFeatures(kind).verifiedExternalResumeCommand) return
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
    contextMenu: { group: 'copy', order: 10 },
  },
  {
    id: 'duplicate-agent',
    category: 'create',
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.

    surface: 'session',
    title: 'Duplicate Agent',
    description: '**What it does:** Clones the focused **agent session** into a new pane.\n\n**Use when:** You want a parallel branch of the same conversation.\n\n**Notes:** The clone lands in the pool with a **new** badge; place it in any lane.',
    keywords: ['duplicate', 'clone', 'fork', 'copy', 'session', 'agent'],
    when: ({ workspace, target }) => {
      // Needs a providerSessionId (something on disk to duplicate) AND a
      // transcript adapter able to project it into a new session. Agent-hood
      // alone proves neither.
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      return (
        getProviderFeatures(kind).transcriptDuplicate &&
        Boolean(meta?.providerSessionId)
      )
    },
    run: async ({ workspace, ui, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Runtime narrow mirroring the `when` predicate EXACTLY. It previously
      // re-checked agent-hood while `when` checked `transcriptDuplicate`, so
      // the two disagreed for any agent provider without an adapter: `when`
      // correctly hid the row, but a programmatic dispatch or a stale
      // keybinding reaching `run` sailed past this weaker check and called
      // `duplicateSession` on a transcript nothing can project.
      if (!getProviderFeatures(kind).transcriptDuplicate) return
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
        // WHY the capability choices travel with the transcript clone: built-in MCP credentials
        // are deliberately ephemeral, but the user's decision to enable a domain is durable pane
        // metadata. Passing only the new provider transcript id created a clone that worked until
        // restart, then rehydrate had no domain names from which to mint a fresh project-scoped
        // token. The clone inherits CHOICES, never the source session's bearer token, and resolves
        // them against current Settings the way every other new provider process does.
        // The comment below still explains WHY this routes through the spawn
        // flow rather than newTab; the 'vertical' direction argument it used
        // to pass died with the tile tree (#992) — placement is context-places
        // now (fills the focused lane when empty, else pools).
        const continuation = {
          resumeSessionId: newProviderSessionId,
          builtInMcpOverrides: clonedMcpOverrides(meta),
          // OpenCode Terminal and rendered OpenCode share a provider kind.
          // The transcript clone should branch the current experience, not
          // silently reinterpret a terminal clone as a rendered session.
          providerRuntime: meta.providerRuntime,
          // WHY cwd is part of the continuation payload: command targeting may resolve a
          // related/orchestration child displayed inside a parent pane. That child's transcript
          // and MCP domains must be re-registered against the CHILD worktree, not whichever
          // physical pane happens to host its UI.
          cwd: meta.cwd,
        }
        // #1180 review: with an explicit target (the Sessions row menu) the
        // clone is filed under the SOURCE agent's project and left unplaced.
        // `splitFocused` resolves ownership and placement from the focused
        // lane, so duplicating a row from project B while focused in project
        // A filed the clone under A — and could drop it into A's empty lane,
        // against the menu's "nothing moves" rule (D5). The palette keeps
        // `splitFocused`: there the source IS the focused agent, and filling
        // an empty focused lane is the behavior users already rely on.
        if (target !== undefined && meta.projectId) {
          await workspace.createDetachedDispatchAgent(
            { kind, providerRuntime: meta.providerRuntime },
            { tabId: meta.projectId, anchorSessionId: sessionId },
            continuation,
            { selectCreated: false },
          )
          // Unplaced means nothing on screen changed, so say where it went.
          // (A targeted pane toast also shows globally while the source is
          // off screen — see targetedCommandContext.)
          workspace.showPaneToast(sessionId, 'Duplicated — the copy is marked new in the Sessions list', 4000)
        } else {
          await workspace.splitFocused(kind, continuation)
        }
      } catch (err) {
        // Surface the failure as a pane toast, not just console.warn. Native
        // transcript export/import crosses both a CLI and storage boundary, so
        // an adapter rejection or transport/fs error must remain actionable
        // instead of silently leaving the user wondering where the clone went.
        // Console output is retained for engineering triage.
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Duplicate agent failed'
        workspace.showPaneToast(sessionId, message)
        // eslint-disable-next-line no-console
        console.warn('[duplicate-agent] failed', err)
      }
    },
    contextMenu: { group: 'agent', order: 40 },
  },
  {
    id: 'switch-provider',
    category: 'session',
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.

    surface: 'session',
    title: 'Switch Provider',
    description: '**What it does:** Opens a destination picker for continuing the focused agent with another provider: Claude, Codex, OpenCode, OpenCode Terminal, Grok or Pi.\n\n**Use when:** You want to continue the same work with a different provider.\n\n**Notes:** Saved sessions are translated; empty panes are replaced with a fresh pane.',
    keywords: ['provider', 'switch', 'claude', 'codex', 'opencode', 'grok', 'pi', 'translate'],
    getState: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      const meta = sessionId ? workspace.state.sessions[sessionId] : null
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // The provider name is CONTEXT — which provider this command would act on —
      // not an enabled state. Styled with accent tone it read as a live toggle.
      return value(
        getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER)
          .shortLabel,
      )
    },
    when: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return false
      const meta = workspace.state.sessions[sessionId]
      if (!meta) return false
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // The explicit switch EDGE list, not agent-hood. "Can switch" is
      // meaningless without naming a destination, and translation is
      // directional — one decoder/projector registration does not excuse a
      // provider from declaring the product paths it supports.
      return getProviderFeatures(kind).switchTargets.length > 0
    },
    run: ({ workspace, ui, target }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      // WHY capture before closing the palette: command targeting in Dispatch
      // can differ from the active grid tab and may change while a modal is
      // open. The picker carries this exact id through selection instead of
      // re-reading whichever pane happens to be focused at commit time.
      ui.closePalette()
      ui.openProviderSwitchPicker(sessionId)
    },
    contextMenu: { group: 'agent', order: 20, title: 'Switch Provider…' },
  },
  {
    id: 'toggle-git-bar',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Git Bar',
    description: '**What it does:** Shows or hides the **Git** side panel.\n\n**Use when:** You want repository status for the focused project.\n\n**Notes:** Uses the focused command target’s working directory.',
    getState: ({ flags }) => toggle(flags.gitBarOpen),
    run: ({ ui }) => ui.toggleGitBar(),
  },
  {
    id: 'toggle-debug-panel',
    category: 'developer',
    pickerVisibility: 'debug',
    surface: 'debug',
    title: 'Debug Panel',
    description: '**What it does:** Shows or hides the focused pane’s **debug panel**.\n\n**Use when:** You need low-level pane or runtime state.\n\n**Notes:** Developer-oriented.',
    getState: ({ flags }) => toggle(flags.debugPanelOpen),
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
    getState: ({ flags }) => toggle(flags.feedDebugPanelOpen),
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
    getState: ({ flags }) => toggle(flags.proxyDebugPanelOpen),
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
      return runSaveDebugBundleCommand(workspace)
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
    title: 'Session Recording',
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
      return runToggleSessionRecordingCommand(workspace)
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
    title: 'Attach Recording Note…',
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
      return runAttachRecordingNoteCommand(workspace)
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
    // Danger tone is no longer authored here. This mode intercepts every click
    // in the feed, so it IS worth flagging — but tone is derived from meaning,
    // and the meaning is "on". The detail carries the warning instead, which is
    // both more informative and impossible to drift from the actual state.
    getState: ({ flags }) =>
      toggle(flags.renderingDebugMode, {
        detail: flags.renderingDebugMode
          ? 'Feed clicks are intercepted while this is on'
          : undefined,
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
    getState: ({ flags }) => toggle(flags.htmlDebugPanelOpen),
    run: ({ ui }) => ui.toggleHtmlDebugPanel(),
  },
  {
    id: 'clear-agent-composer',
    category: 'session',
    surface: 'session',
    title: 'Clear Agent Composer',
    description: "**What it does:** Clears text sitting in the **agent's own composer** — the provider's input line, not Agent Code's.\n\n**Use when:** The pane says *draft in agent composer* and sends are being refused.\n\n**Notes:** Agent Code will never overwrite a draft in the provider's composer, so anything left there — typed in the raw terminal view, or stranded by a failed send — blocks every later prompt until it is cleared. This clears it for you.",
    keywords: ['clear', 'composer', 'draft', 'stuck', 'occupied', 'blocked', 'unblock', 'human draft'],
    // Shown only while the gate is actually blocked on a draft (#683). The
    // whole problem was that this state is indistinguishable from a slow boot,
    // so surfacing the remedy exactly when it applies is most of the fix:
    // the user finds it by looking for what is wrong, not by knowing it exists.
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      return workspace.getRuntime(sessionId)?.inputReadinessReason === 'composer-occupied'
    },
    run: async ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      // The routine itself (spaced Ctrl+U presses, never ESC, a fixed count)
      // and every reason behind that shape live in clearAgentComposer.ts —
      // shared with the composer's Escape recovery path (#737) so the two
      // cannot drift.
      await clearAgentComposer(sessionId)
      // States what was DONE, not what was achieved. From the renderer we
      // cannot confirm the composer is empty; the pane's own readiness line is
      // the honest signal, and it updates on the next gate evaluation.
      workspace.showPaneToast(sessionId, "Sent a clear to the agent's composer")
    },
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
    getState: ({ flags }) => toggle(flags.devDebugPanelOpen),
    run: ({ ui }) => ui.toggleDevDebugPanel(),
  },
]
