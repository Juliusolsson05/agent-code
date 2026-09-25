import { GOAL_INSTRUCTIONS, TLDR_INSTRUCTIONS, TLDR_MAX_CHARACTERS } from '@shared/types/tldr.js'
import { AUTO_TITLE_INSTRUCTIONS } from '@shared/types/autoTitle.js'
import {
  GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS,
  GOAL_LOOP_INSTRUCTIONS,
  GOAL_LOOP_MAX_CONTINUATIONS_CEILING,
  GOAL_LOOP_MAX_GOAL_CHARACTERS,
  GOAL_LOOP_MAX_PROMPT_CHARACTERS,
  GOAL_LOOP_MAX_SUMMARY_CHARACTERS,
} from '@shared/types/goalLoop.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  inspectAgentTranscriptFile,
  readAgentTranscriptFile,
  searchAgentTranscriptFile,
} from '@main/agentTranscripts/AgentTranscriptReader.js'
import {
  AGENT_TRANSCRIPT_ITEM_KINDS,
  AGENT_TRANSCRIPT_PROJECTIONS,
} from '@mcp/shared/agentTranscriptTypes.js'
import type {
  OrchestrationAgentKind,
  OrchestrationAgentOutput,
  OrchestrationAgentRecord,
} from '@mcp/shared/orchestrationTypes.js'
import { buildOrchestrationBootstrapPrompt } from '@mcp/shared/orchestrationPrompt.js'
import { BROWSER_INSTRUCTIONS, registerBrowserTools } from '@mcp/runtime/browserTools.js'
import type { BuiltInMcpDependencies } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'
import { BUILT_IN_MCP_DOMAINS, PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS } from '@mcp/shared/types.js'
import type { BuiltInMcpDomain, McpSessionScope } from '@mcp/shared/types.js'
import type { SessionKind } from '@main/sessionManager.js'
import {
  AGENT_PROVIDER_KINDS,
  AGENT_PROVIDER_RUNTIMES,
  DEFAULT_PROVIDER,
  isAgentProviderKind,
} from '@shared/types/providerKind.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { registerWorkflowMcpTools, WORKFLOW_MCP_INSTRUCTIONS } from 'workflow-mcp'
import { MCP_SERVERS_INSTRUCTIONS, registerUserMcpTools } from '@mcp/runtime/userMcpTools.js'
import { registerSkillsTools, SKILLS_INSTRUCTIONS } from '@mcp/runtime/skillsTools.js'

export const AGENT_MANAGEMENT_MCP_INSTRUCTIONS = `Agent Management controls Agent Code sessions only in the caller's exact current project tab. Listing and reading are safe audit operations and do not wake parked agents; sending a prompt may wake the named target. For cleanup-review requests, use the inventory plus bulk transcript read, classify agents as active/do not close, uncertain/inspect first, or likely cleanup candidates, and cite lifecycle, transcript, relationship, condition, and activity evidence rather than treating age alone as proof. A missing or truncated transcript is not an empty transcript, and an unresolved latest user request or tool work without a final response belongs in inspect first. Transcript evidence cannot prove a worktree is clean unless that transcript or another tool actually checked it; state what remains unknown. Asking what is safe to clean up authorizes assessment only. Reading an agent or sending it a prompt never grants permission to close it. Never call agent_management_close_agent unless the user's current request explicitly asks you to close that specific agent. A request to inspect agents, identify stale agents, recommend cleanup, manage the project, or say what is safe to clean up is not authorization to close anything. Do not infer closure permission from age, completion state, transcript contents, or a prior request. When the user names an agent by the label shown beside it (such as B28) or by its spoken agent name, pass that as \`label\` or \`name\` exactly as the user said it instead of translating it to a sessionId yourself: it is resolved against what the user sees at the moment of the call. Labels are screen positions that renumber when earlier agents close, move or are pinned, so never reuse a label or sessionId remembered from earlier in the conversation, and repeat the returned displayLabel to the user so they can confirm which agent you reached. Session IDs also change when an agent reloads.`

/**
 * Instructions for a session whose user enabled Root Agent Code Management.
 *
 * WHY the caller's own session ID is spelled out: the `ac_*` catalog can
 * close, reload and provider-switch ANY session, and the model
 * only knows itself as "this conversation". Naming the ID is the one fact
 * that lets it keep its own pane out of a reorganization. The authorization
 * language mirrors Agent Management's, with a wider allowed surface (placement
 * and focus) because reorganizing the workspace is the feature's purpose.
 */
export function rootManagementInstructions(sessionId: string): string {
  return `Root Agent Code Management is enabled for this agent by an explicit user action confirmed in a dialog; it is off for every other agent. The ac_* tools are the application-wide operator control surface: every window, project tab, agent, terminal and layout in Agent Code, not only the caller's project. Start with ac_app_describe, then ac_app_observe or ac_app_windows for identities. Act on session and tab IDs: when the user names an agent by its visible label (such as B28) or its spoken name, resolve it with ac_agents_search (label or name, scoped to the window) and act on the sessionId it returns. Labels are screen positions that renumber when earlier agents close, move or are pinned. Session IDs change whenever an agent reloads, including the reload that enabled this capability, so re-read IDs instead of reusing ones from earlier in the conversation. Your own Agent Code session ID is ${sessionId}: never close, reload, rewind or switch the provider of that session. Prefer reads, make the smallest layout change that satisfies the user's current request, and re-read the layout revision after every mutation. Never close, kill, switch providers for, or prompt another agent unless the user's current request names that agent or that outcome; a request to organize, tidy or focus the workspace authorizes placement, focus, pin and title changes only. The app's own confirmation dialogs still apply, and a declined dialog is a refusal, not a reason to retry. When you finish, say exactly what you changed and where.`
}

export function createBuiltInMcpServer(
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies = {},
): McpServer {
  const server = new McpServer(
    {
      name: 'agent-code-built-in',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      // WHY domain instructions travel in MCP initialization instead of Agent
      // Code's chat prompt: tools can be discovered lazily, and a session must
      // not be taught capabilities it cannot call. The close authorization
      // rule is repeated in the destructive tool description below because
      // clients differ in how prominently they surface server instructions.
      ...(builtInInstructions(scope, dependencies)
        ? { instructions: builtInInstructions(scope, dependencies) }
        : {}),
    },
  )

  if (scope.domains.includes('tldr')) {
    server.registerTool('tldr_update', {
      title: 'Update TLDR',
      description: 'Replace your own current TLDR with one or two short sentences: required user decision first, otherwise verified outcome and next step. Update after substantial work/discussion; skip minor unchanged clarifications.',
      inputSchema: { text: z.string().min(1).max(TLDR_MAX_CHARACTERS * 2) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ text }) => {
      try {
        if (!dependencies.tldrStore) throw new Error('TLDR is unavailable.')
        const record = await dependencies.tldrStore.update(
          scope.tldrIdentity ?? scope.sessionId, text,
          dependencies.isTldrWriteAuthorized ?? (() => false),
        )
        return toolText({ ok: true, ...record })
      } catch (error) {
        return { ...toolText({ ok: false, message: error instanceof Error ? error.message : 'TLDR update failed.' }), isError: true }
      }
    })
  }

  if (scope.domains.includes('goal')) {
    // Same authority model as tldr_update: the target is the authenticated
    // scope's identity, never a model-supplied id, and a revoked process's
    // queued write fails after the store's I/O instead of overwriting its
    // successor's goal.
    server.registerTool('goal_set', {
      title: 'Set goal',
      description: 'Record what your work is trying to achieve, in one plain sentence. Set it once you understand a new task; update it only when the user changes direction, never to report progress.',
      inputSchema: { text: z.string().min(1).max(TLDR_MAX_CHARACTERS * 2) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ text }) => {
      try {
        if (!dependencies.goalStore) throw new Error('Goal is unavailable.')
        const record = await dependencies.goalStore.update(
          scope.tldrIdentity ?? scope.sessionId, text,
          dependencies.isTldrWriteAuthorized ?? (() => false),
        )
        return toolText({ ok: true, ...record })
      } catch (error) {
        return { ...toolText({ ok: false, message: error instanceof Error ? error.message : 'Goal update failed.' }), isError: true }
      }
    })

    // #1182. Registered with `goal` rather than as its own domain: it only
    // records a flag on the caller's own goal, and the user's bulk close still
    // asks before anything closes, so a separate toggle would add a setting
    // without adding safety. Same authority model as goal_set.
    //
    // The description carries the WHEN rule as well as the instructions do,
    // for the same reason the close tool repeats its authorization rule:
    // clients differ in how prominently they surface server instructions, and
    // an early completion is exactly what would put a still-needed agent in
    // the user's close list.
    server.registerTool('goal_complete', {
      title: 'Complete goal',
      description: 'Mark your goal as achieved, with one plain sentence saying what was delivered. Call it only after the user has accepted the result (for example the PR is merged or the user said it is done) — never while a PR, review, CI or any requested work is still open. Setting a new goal with goal_set clears it.',
      inputSchema: { summary: z.string().min(1).max(TLDR_MAX_CHARACTERS * 2) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ summary }) => {
      try {
        if (!dependencies.goalStore) throw new Error('Goal is unavailable.')
        const record = await dependencies.goalStore.complete(
          scope.tldrIdentity ?? scope.sessionId, summary,
          dependencies.isTldrWriteAuthorized ?? (() => false),
        )
        return toolText({ ok: true, ...record })
      } catch (error) {
        return { ...toolText({ ok: false, message: error instanceof Error ? error.message : 'Goal completion failed.' }), isError: true }
      }
    })
  }

  if (scope.domains.includes('auto_title')) {
    // The bearer registration, not model input, chooses the session. This is
    // narrower than agents.titleSet (an operator capability that can title any
    // exact target) and makes the tool safe to offer to ordinary agents.
    server.registerTool('title_set', {
      title: 'Set own agent title',
      description: 'Set your own short current-job title in 3–7 words, at most 60 characters. Call when you understand new substantive work or its direction changes; leave it alone for routine progress. Manual titles and clears are protected.',
      inputSchema: { title: z.string().min(1).max(120) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ title }) => {
      try {
        const normalized = title.replace(/\s+/gu, ' ').trim()
        if (!normalized || [...normalized].length > 60 || /[\u0000-\u001f\u007f]/u.test(title)) {
          throw new Error('Auto Title must be one line of 1–60 characters.')
        }
        if (!dependencies.isTitleWriteAuthorized?.()) throw new Error('Auto Title session is no longer active.')
        if (!dependencies.setOwnAutoTitle) throw new Error('Auto Title is unavailable.')
        const saved = await dependencies.setOwnAutoTitle(scope.sessionId, normalized, dependencies.isTitleWriteAuthorized)
        if (!dependencies.isTitleWriteAuthorized()) throw new Error('Auto Title session is no longer active.')
        return toolText({ ok: true, title: saved })
      } catch (error) {
        return { ...toolText({ ok: false, message: error instanceof Error ? error.message : 'Auto Title update failed.' }), isError: true }
      }
    })
  }

  if (scope.domains.includes('goal_loop')) {
    registerGoalLoopTools(server, scope, dependencies)
  }

  if (scope.domains.includes('ping')) {
    server.registerTool(
      'agent_code_ping',
      {
        title: 'Agent Code MCP Ping',
        description:
          'Checks that this agent was reloaded with Agent Code built-in MCP access for its scoped session.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              sessionId: scope.sessionId,
              cwd: scope.cwd,
              domains: scope.domains,
            }),
          },
        ],
      }),
    )
  }

  if (scope.domains.includes('orchestration')) {
    registerOrchestrationTools(server, scope, dependencies)
  }

  if (scope.domains.includes('agent_management')) {
    registerAgentManagementTools(server, scope, dependencies)
  }

  if (scope.domains.includes('root_management')) {
    // The registrar closes over the control host's operator port for THIS
    // session (caller kind `agent`), so every call is journaled under the
    // session's identity and application-only capabilities stay out of reach.
    // A missing registrar means composition forgot to wire it; the instructions
    // are withheld too (see builtInInstructions) so the model is never taught
    // tools it cannot call, and the gap is journaled instead of hidden.
    if (dependencies.rootControlTools) {
      dependencies.rootControlTools(server, scope.sessionId)
    } else {
      dependencies.appRunJournal?.record({
        area: 'mcp.root_management',
        name: 'registrar.missing',
        data: { sessionId: scope.sessionId },
      })
    }
  }

  if (scope.domains.includes('ai_workspace')) {
    registerAiWorkspaceTools(server, scope, dependencies)
  }

  if (scope.domains.includes('mcp_servers')) {
    registerUserMcpTools(server, scope, dependencies)
  }

  if (scope.domains.includes('skills')) {
    registerSkillsTools(server, scope, dependencies)
  }

  if (scope.domains.includes('agent_transcripts')) {
    registerAgentTranscriptTools(server)
  }

  if (scope.domains.includes('browser')) {
    // Registers nothing while Browser Pocket is off; see registerBrowserTools.
    registerBrowserTools(server, scope, dependencies.browserPockets)
  }

  if (scope.domains.includes('workflows')) {
    // WHY the service is injected while registration stays request-scoped:
    // BuiltInMcpHttpHost deliberately constructs a fresh McpServer for every
    // POST so a provider's long-lived GET stream cannot wedge tool calls. The
    // workflow service, however, owns active AbortControllers, durable cursors,
    // and the one-writer guarantee for events.jsonl. Recreating that service
    // with the protocol server would split run ownership and make cancel,
    // idempotency, and resume racy. A cheap registrar over one app-owned
    // service preserves both lifetimes.
    if (dependencies.workflowService) {
      registerWorkflowMcpTools(server, dependencies.workflowService, {
        cwd: scope.cwd,
        clientId: scope.sessionId,
      }, {
        onRunStarted: run => {
          // WHY the provider transcript is not consulted here: current Codex intentionally defers
          // MCP tools behind code mode, so the visible outer call is often `functions.exec` rather
          // than `mcp__agent_code__workflow_run`. The scoped MCP handler still has the authoritative
          // session ID and run result, making this boundary stable across Claude, Codex, and future
          // clients regardless of how they choose to present tools to the model.
          dependencies.workflowBridge?.registerRun(scope.sessionId, scope.cwd, run)
        },
      })
    }
  }

  return server
}

function builtInInstructions(
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
): string {
  return [
    ...(scope.domains.includes('goal') ? [GOAL_INSTRUCTIONS] : []),
    ...(scope.domains.includes('auto_title') ? [AUTO_TITLE_INSTRUCTIONS] : []),
    ...(scope.domains.includes('goal_loop') ? [GOAL_LOOP_INSTRUCTIONS] : []),
    ...(scope.domains.includes('tldr') ? [TLDR_INSTRUCTIONS] : []),
    ...(scope.domains.includes('workflows') ? [WORKFLOW_MCP_INSTRUCTIONS] : []),
    ...(scope.domains.includes('agent_management') ? [AGENT_MANAGEMENT_MCP_INSTRUCTIONS] : []),
    ...(scope.domains.includes('browser') && dependencies.browserPockets ? [BROWSER_INSTRUCTIONS] : []),
    ...(scope.domains.includes('mcp_servers') ? [MCP_SERVERS_INSTRUCTIONS] : []),
    ...(scope.domains.includes('skills') ? [SKILLS_INSTRUCTIONS] : []),
    ...(scope.domains.includes('root_management') && dependencies.rootControlTools
      ? [rootManagementInstructions(scope.sessionId)]
      : []),
  ].join('\n\n')
}

function registerGoalLoopTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
): void {
  const service = dependencies.goalLoopService
  // Same authority model as goal_set: the loop targeted is always the
  // authenticated scope's own session, never a model-supplied id, so one
  // agent can neither start nor break another agent's loop.
  const failure = (error: unknown) => ({
    ...toolText({ ok: false, message: error instanceof Error ? error.message : 'Goal Loop call failed.' }),
    isError: true,
  })
  server.registerTool('goal_loop_start', {
    title: 'Start goal loop',
    description: `Start a harness-owned loop that keeps re-prompting this session until the goal is completely done. Write loopPrompt yourself as a self-contained continuation instruction; it is re-sent every time you stop. Call goal_loop_complete only when utterly done, or with outcome "blocked" when you need the user. Budget defaults to ${GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS} continuations.`,
    inputSchema: {
      goal: z.string().min(1).max(GOAL_LOOP_MAX_GOAL_CHARACTERS),
      loopPrompt: z.string().min(1).max(GOAL_LOOP_MAX_PROMPT_CHARACTERS),
      maxContinuations: z.number().int().min(1).max(GOAL_LOOP_MAX_CONTINUATIONS_CEILING).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ goal, loopPrompt, maxContinuations }) => {
    try {
      if (!service) throw new Error('Goal Loop is unavailable.')
      return toolText({ ok: true, loop: await service.startLoop(scope.sessionId, { goal, loopPrompt, maxContinuations }) })
    } catch (error) {
      return failure(error)
    }
  })
  server.registerTool('goal_loop_complete', {
    title: 'Complete goal loop',
    description: 'End this session\'s goal loop. Call with outcome "done" ONLY when the goal is completely and utterly satisfied and verified — never to exit early. Call with outcome "blocked" when you genuinely need the user, and say exactly what you need in the summary.',
    inputSchema: {
      outcome: z.enum(['done', 'blocked']),
      summary: z.string().min(1).max(GOAL_LOOP_MAX_SUMMARY_CHARACTERS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ outcome, summary }) => {
    try {
      if (!service) throw new Error('Goal Loop is unavailable.')
      return toolText({ ok: true, loop: await service.complete(scope.sessionId, outcome, summary) })
    } catch (error) {
      return failure(error)
    }
  })
}

/**
 * How a model names ONE Agent Management target (#1145).
 *
 * WHY three optional fields rather than one polymorphic string: a UUID, "B28"
 * and "Apollo" can't collide today, but a single field would make every
 * handler sniff the shape, and a name that happened to look like a label would
 * silently change meaning. Separate fields keep the caller's intent explicit
 * and the resolver's branches honest.
 *
 * WHY "exactly one" is enforced in the handler (targetFromArgs), not in zod:
 * the SDK publishes a raw shape as the tool's JSON Schema; a `.refine` turns
 * it into an effects schema whose properties are not advertised, and the model
 * would lose the very field descriptions that tell it labels are accepted.
 *
 * The label regex is the one `ac_agents_search` uses, so both surfaces accept
 * the same strings. Pinned `★N` labels are outside it on both — target a
 * pinned agent by sessionId or name.
 */
const MANAGED_TARGET_FIELDS = {
  sessionId: z.string().min(1).optional()
    .describe('Agent Code session ID from agent_management_list_agents. Give exactly one of sessionId, label or name.'),
  label: z.string().trim().regex(/^[A-Za-z]+[1-9]\d*$/).optional()
    .describe('The label shown beside the agent right now, e.g. B28 (case-insensitive). Resolved against the live screen at call time; labels renumber when earlier agents close, so pass what the user just said rather than one remembered from earlier.'),
  name: z.string().trim().min(1).max(120).optional()
    .describe('Exact spoken agent name, e.g. "Apollo" (case-insensitive, never a substring). Only resolves while the Agent names setting is on.'),
}

function targetFromArgs(args: {
  sessionId?: string
  label?: string
  name?: string
}): { sessionId?: string; label?: string; name?: string } {
  const target = {
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
  }
  if (Object.keys(target).length !== 1) {
    // Refused before the bridge: an ambiguous request must not reach the
    // renderer, where the send path may already wake the agent.
    const error = new Error(
      'Name the target with exactly one of sessionId, label or name.',
    ) as Error & { code: string }
    error.code = 'invalid_target'
    throw error
  }
  return target
}

function registerAgentManagementTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
): void {
  const bridge = dependencies.agentManagementBridge
  const response = async <T extends object>(operation: () => Promise<T>) => {
    if (!bridge) {
      return toolText({
        ok: false,
        error: 'agent_management_unavailable',
        message: 'Agent Management is not available in this Agent Code process.',
      })
    }
    try {
      return toolText({ ok: true, ...await operation() })
    } catch (error) {
      const structured = error as {
        code?: unknown
        message?: unknown
        details?: unknown
      }
      return toolText({
        ok: false,
        error: typeof structured.code === 'string' ? structured.code : 'request_failed',
        message: typeof structured.message === 'string'
          ? structured.message
          : 'Agent management request failed.',
        ...(structured.details && typeof structured.details === 'object'
          ? structured.details as object
          : {}),
      })
    }
  }

  server.registerTool(
    'agent_management_list_agents',
    {
      title: 'List Project Agents',
      description:
        'Lists every Agent Code agent in the caller\'s exact project, including the ones that are not in a lane. Each agent carries displayLabel (the label the user sees beside it, e.g. B28, or null) and agentName when Agent names is on. Labels are screen positions, not identities: to act on one, pass it as `label` to the other tools. Also returns transcript paths/availability, backend and activity state, last activity, idle duration, conditions, and relationships. This read-only audit does not wake agents.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => response(async () => await bridge!.listAgents({
      callerSessionId: scope.sessionId,
    })),
  )

  server.registerTool(
    'agent_management_read_agent',
    {
      title: 'Read Project Agent',
      description:
        'Reads bounded visible user/assistant transcript output for one agent in the caller\'s project, named by sessionId, visible label or spoken name. It may hydrate durable history but never wakes a parked agent.',
      inputSchema: {
        ...MANAGED_TARGET_FIELDS,
        maxMessages: z.number().int().min(1).max(100).optional(),
        maxCharsPerMessage: z.number().int().min(50).max(100_000).optional(),
        maxCharsPerAgent: z.number().int().min(100).max(500_000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async args => response(async () => ({
      output: await bridge!.readAgent({
        callerSessionId: scope.sessionId,
        target: targetFromArgs(args),
        maxMessages: args.maxMessages,
        maxCharsPerMessage: args.maxCharsPerMessage,
        maxCharsPerAgent: args.maxCharsPerAgent,
      }),
    })),
  )

  server.registerTool(
    'agent_management_read_agents',
    {
      title: 'Read Project Agents',
      description:
        'Bulk-reads bounded transcript output and inventory facts for selected agents, or all agents in the caller\'s project. Intended for questions such as “read all agents and tell me what looks safe to clean up.” This only recommends; it never closes or wakes agents.',
      inputSchema: {
        sessionIds: z.array(z.string()).max(200).optional(),
        labels: z.array(MANAGED_TARGET_FIELDS.label.unwrap()).max(200).optional()
          .describe('Visible labels (e.g. B28), resolved against the live screen at call time. Combined with sessionIds and names; any given list makes this an explicit selection.'),
        names: z.array(MANAGED_TARGET_FIELDS.name.unwrap()).max(200).optional()
          .describe('Exact spoken agent names; only resolve while Agent names is on.'),
        includeCaller: z.boolean().optional(),
        maxMessagesPerAgent: z.number().int().min(1).max(100).optional(),
        maxCharsPerMessage: z.number().int().min(50).max(100_000).optional(),
        maxCharsPerAgent: z.number().int().min(100).max(500_000).optional(),
        maxTotalChars: z.number().int().min(1_000).max(1_000_000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async args => response(async () => await bridge!.readAgents({
      callerSessionId: scope.sessionId,
      sessionIds: args.sessionIds,
      labels: args.labels,
      names: args.names,
      includeCaller: args.includeCaller,
      maxMessagesPerAgent: args.maxMessagesPerAgent,
      maxCharsPerMessage: args.maxCharsPerMessage,
      maxCharsPerAgent: args.maxCharsPerAgent,
      maxTotalChars: args.maxTotalChars,
    })),
  )

  server.registerTool(
    'agent_management_send_prompt',
    {
      title: 'Send Prompt To Project Agent',
      description:
        'Sends a prompt to one other agent in the caller\'s project, named by sessionId, visible label (e.g. B28) or spoken name. Returns the resolved sessionId and displayLabel so you can tell the user which agent received it. This may wake a parked target; it cannot target the caller itself.',
      inputSchema: {
        ...MANAGED_TARGET_FIELDS,
        prompt: z.string().trim().min(1).max(500_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async args => response(async () => {
      const { sessionId, displayLabel, delivery } = await bridge!.sendPrompt({
        callerSessionId: scope.sessionId,
        target: targetFromArgs(args),
        prompt: args.prompt,
      })
      if (!delivery.ok) {
        // WHY a provider-declared failure is promoted to the tool's top level:
        // models reliably branch on the outer `ok` field. Returning ok:true
        // beside delivery.ok:false made uncertain post-write failures easy to
        // skim as success and retry, even though the disposition was preserved.
        const error = new Error(delivery.message) as Error & {
          code: string
          details: Record<string, unknown>
        }
        error.code = 'prompt_delivery_failed'
        error.details = {
          sessionId,
          displayLabel,
          retrySafe: delivery.retrySafe,
          stage: delivery.stage,
          code: delivery.code,
          disposition: delivery.disposition,
          promptWritten: delivery.promptWritten,
          enterWritten: delivery.enterWritten,
          promptSubmission: delivery.retrySafe ? 'not-submitted' : 'uncertain',
        }
        throw error
      }
      return { sessionId, displayLabel, delivery }
    }),
  )

  server.registerTool(
    'agent_management_close_agent',
    {
      title: 'Close Project Agent',
      description:
        'Destructive. Call only when the current user explicitly asks to close this specific agent. Never infer close permission from task completion, inactivity, a request to assess what looks safe to clean up, an error, or permission to list/read/prompt agents. Closes exactly one other Agent Code agent in the caller\'s project, named by sessionId, visible label or spoken name, and refuses self-close or any multi-session cascade.',
      inputSchema: {
        ...MANAGED_TARGET_FIELDS,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async args => response(async () => await bridge!.closeAgent({
      callerSessionId: scope.sessionId,
      target: targetFromArgs(args),
    })),
  )
}

function registerAgentTranscriptTools(server: McpServer): void {
  // Derived from AGENT_PROVIDER_KINDS so a newly registered provider is
  // automatically accepted by the transcript tools (#394 phase 1).
  const providerSchema = z.enum([...AGENT_PROVIDER_KINDS, 'auto'] as const).default('auto')
  const projectionSchema = z.enum(AGENT_TRANSCRIPT_PROJECTIONS)
  const itemKindSchema = z.enum(AGENT_TRANSCRIPT_ITEM_KINDS)
  const includeSchema = z.object({
    userMessages: z.boolean().optional(),
    assistantMessages: z.boolean().optional(),
    toolReads: z.boolean().optional(),
    toolWrites: z.boolean().optional(),
    shellCommands: z.boolean().optional(),
    patches: z.boolean().optional(),
    testRuns: z.boolean().optional(),
    rawToolOutputs: z.boolean().optional(),
  }).optional()

  // WHY these tools take an explicit transcript locator instead of trying to
  // discover "the right" transcript:
  //
  // The product use case is controlled consumption of another agent's work
  // product, not a global transcript browser. The UI, orchestration metadata,
  // or a handoff prompt already knows which transcript matters: a Claude or
  // Codex JSONL path, or an `opencode://session/<id>` locator for OpenCode,
  // whose sessions live in one database with no file per session (Agent
  // Management publishes whichever the agent has).
  // Discovery would force this MCP boundary to decide ownership, scoping, and
  // ranking semantics that are unrelated to projection. A path-in API keeps v1
  // auditable and predictable: the caller names the transcript, then chooses a
  // bounded projection such as final answer, assistant messages, commands, or
  // timeline. We intentionally do not provider-root allowlist here because the
  // local agent/user is already trusted to pass a transcript path on this
  // machine; invalid paths fail cleanly instead of being policy-blocked.
  server.registerTool(
    'agent_transcript_read_file',
    {
      title: 'Read Agent Transcript File',
      description:
        'Reads one agent transcript and returns a normalized, filtered, bounded projection of user-visible agent context. `path` is a Claude, Codex or Pi transcript JSONL path (a Pi session file is read as its active branch), or `opencode://session/<id>` for an OpenCode session (the locator Agent Management lists for OpenCode agents).',
      inputSchema: {
        path: z.string(),
        provider: providerSchema.optional(),
        projection: projectionSchema,
        include: includeSchema,
        tail: z.number().int().min(1).max(10_000).optional(),
        maxItems: z.number().int().min(1).max(10_000).optional(),
        maxChars: z.number().int().min(100).max(500_000).optional(),
        maxCharsPerItem: z.number().int().min(50).max(100_000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async args => toolText(await readAgentTranscriptFile({
      path: args.path,
      provider: args.provider,
      projection: args.projection,
      include: args.include,
      tail: args.tail,
      maxItems: args.maxItems,
      maxChars: args.maxChars,
      maxCharsPerItem: args.maxCharsPerItem,
    })),
  )

  server.registerTool(
    'agent_transcript_search_file',
    {
      title: 'Search Agent Transcript File',
      description:
        'Searches one agent transcript and returns bounded normalized matches with optional surrounding context. `path` is a Claude, Codex or Pi transcript JSONL path, or `opencode://session/<id>` for an OpenCode session.',
      inputSchema: {
        path: z.string(),
        provider: providerSchema.optional(),
        query: z.string(),
        kinds: z.array(itemKindSchema).optional(),
        maxMatches: z.number().int().min(1).max(1000).optional(),
        contextItems: z.number().int().min(0).max(20).optional(),
        maxCharsPerMatch: z.number().int().min(50).max(100_000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async args => toolText(await searchAgentTranscriptFile({
      path: args.path,
      provider: args.provider,
      query: args.query,
      kinds: args.kinds,
      maxMatches: args.maxMatches,
      contextItems: args.contextItems,
      maxCharsPerMatch: args.maxCharsPerMatch,
    })),
  )

  server.registerTool(
    'agent_transcript_inspect_file',
    {
      title: 'Inspect Agent Transcript File',
      description:
        'Inspects one agent transcript and returns provider, timestamp, and item-count metadata without dumping content. `path` is a Claude, Codex or Pi transcript JSONL path, or `opencode://session/<id>` for an OpenCode session.',
      inputSchema: {
        path: z.string(),
        provider: providerSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async args => toolText(await inspectAgentTranscriptFile({
      path: args.path,
      provider: args.provider,
    })),
  )
}

function registerAiWorkspaceTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
): void {
  const scopeSchema = z.record(z.string(), z.unknown()).optional()
  const metadataSchema = z.record(z.string(), z.unknown()).optional()

  server.registerTool(
    'ai_workspace_create',
    {
      title: 'Create AI Workspace',
      description:
        'Creates or returns a named Agent Code AI Workspace for curating files into a user-facing cross-worktree review surface.',
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        scope: scopeSchema,
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const workspace = await registry.create({
        name: args.name,
        description: args.description,
        scope: {
          parentSessionId: scope.sessionId,
          cwd: scope.cwd,
          ...(args.scope ?? {}),
        },
      })
      return toolText({ ok: true, workspace })
    },
  )

  server.registerTool(
    'ai_workspace_attach_file',
    {
      title: 'Attach File To AI Workspace',
      description:
        'Attaches an existing absolute file path to an AI Workspace. Use this for plans, notes, diffs, or review artifacts the user should inspect together.',
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        sourceSessionId: z.string().optional(),
        sourceAgentLabel: z.string().optional(),
        taskId: z.string().optional(),
        metadata: metadataSchema,
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const entry = await registry.attachFile({
        workspaceId: args.workspaceId,
        path: args.path,
        title: args.title,
        description: args.description,
        sourceSessionId: args.sourceSessionId ?? scope.sessionId,
        sourceAgentLabel: args.sourceAgentLabel,
        taskId: args.taskId,
        metadata: args.metadata,
      })
      return toolText({ ok: true, entry })
    },
  )

  server.registerTool(
    'ai_workspace_detach_file',
    {
      title: 'Detach File From AI Workspace',
      description:
        'Removes one file reference from an AI Workspace. This never deletes the real file from disk.',
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().optional(),
        entryId: z.string().optional(),
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const result = await registry.detachFile({
        workspaceId: args.workspaceId,
        path: args.path,
        entryId: args.entryId,
      })
      return toolText({ ok: true, ...result })
    },
  )

  server.registerTool(
    'ai_workspace_list_files',
    {
      title: 'List AI Workspace Files',
      description:
        'Lists files attached to one AI Workspace, including stale/missing/readability status.',
      inputSchema: {
        workspaceId: z.string(),
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const workspace = await registry.get(args.workspaceId)
      return toolText({ ok: Boolean(workspace), workspace })
    },
  )

  server.registerTool(
    'ai_workspace_list_workspaces',
    {
      title: 'List AI Workspaces',
      description:
        'Lists available AI Workspaces with counts and timestamps so the agent can pick the right curated review surface.',
      inputSchema: {},
    },
    async () => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const workspaces = await registry.list()
      return toolText({ ok: true, workspaces })
    },
  )

  server.registerTool(
    'ai_workspace_open',
    {
      title: 'Open AI Workspace',
      description:
        'Opens an AI Workspace in the Agent Code UI for the user. Call this after curating files when the user should review the workspace now.',
      inputSchema: {
        workspaceId: z.string(),
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const workspace = await registry.get(args.workspaceId)
      if (!workspace) {
        return toolText({
          ok: false,
          error: 'ai_workspace_not_found',
          message: 'AI Workspace not found.',
        })
      }
      dependencies.openAiWorkspace?.(args.workspaceId)
      return toolText({ ok: true, workspaceId: args.workspaceId })
    },
  )

  server.registerTool(
    'ai_workspace_clear',
    {
      title: 'Clear AI Workspace',
      description:
        'Removes every file reference from an AI Workspace. This never deletes real files from disk.',
      inputSchema: {
        workspaceId: z.string(),
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const result = await registry.clear(args.workspaceId)
      return toolText({ ok: true, ...result })
    },
  )

  server.registerTool(
    'ai_workspace_delete',
    {
      title: 'Delete AI Workspace',
      description:
        'Deletes an AI Workspace record and its file references. This never deletes real files from disk.',
      inputSchema: {
        workspaceId: z.string(),
      },
    },
    async args => {
      const registry = dependencies.aiWorkspaceRegistry
      if (!registry) return unavailableAiWorkspace()
      const result = await registry.delete(args.workspaceId)
      return toolText({ ok: true, ...result })
    },
  )
}

function unavailableAiWorkspace(): {
  content: Array<{ type: 'text'; text: string }>
} {
  return toolText({
    ok: false,
    error: 'ai_workspace_unavailable',
    message: 'Agent Code AI Workspace services are not available.',
  })
}

function registerOrchestrationTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
): void {
/**
 * The `orchestration_create_agent` argument schema, named so the duplicate-call
 * key below can be made exhaustive over it at compile time (#952 review, 6).
 */
const ORCHESTRATION_CREATE_AGENT_INPUT = {
  kind: z.enum(AGENT_PROVIDER_KINDS).default(DEFAULT_PROVIDER),
  providerRuntime: z.enum(AGENT_PROVIDER_RUNTIMES).optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  role: z.string().optional(),
  runId: z.string().optional(),
  inheritParentContext: z.boolean().optional().describe(
    [
      'Temporarily ignored.',
      'Agent Code currently disables orchestration context inheritance because transcript duplication/translation was not stable enough for production child-agent work.',
      'Pass all required context in the prompt until the inheritance path is redesigned.',
    ].join(' '),
  ),
  // WHY derive this from the registry: child capability grants are an
  // authority boundary. A hand-maintained schema can silently reject a
  // newly registered domain or keep accepting one the runtime removed.
  builtInMcpDomains: z.array(z.enum(BUILT_IN_MCP_DOMAINS)).optional(),
}

type OrchestrationCreateAgentArgs = {
  [K in keyof typeof ORCHESTRATION_CREATE_AGENT_INPUT]?:
    z.infer<(typeof ORCHESTRATION_CREATE_AGENT_INPUT)[K]>
}

/**
 * Identity of one `orchestration_create_agent` call: two calls with the same
 * key ask for the same thing and only one of them should happen (#952).
 *
 * ── WHY THE `Record<keyof …>` ──
 * The key must cover EVERY argument. A field left out does not fail loudly;
 * it silently collapses two calls that differ only in that field, and the
 * caller never learns their job was dropped. Review found five such fields in
 * the first version (`cwd`, `providerRuntime`, `runId`, `role`,
 * `builtInMcpDomains`) — dropping `cwd` from the key would have handed a
 * caller a child working in the wrong repository. Typing the object as
 * `Record<keyof OrchestrationCreateAgentArgs, unknown>` turns the next added
 * schema field into a compile error here instead.
 *
 * ── NORMALIZATION ──
 * `builtInMcpDomains` is a SET on the wire but an array in JSON, so it is
 * sorted: `['orchestration','tldr']` and `['tldr','orchestration']` request
 * the same child. Absent and `[]` both mean "no domains" downstream
 * (`sessionManager` gates on `length > 0`), so they normalize together.
 * `inheritParentContext` is keyed at the value actually USED — the handler
 * forces `false` — because the key names the child that will be built, and
 * two calls that differ only there build identical children.
 */
function orchestrationCreateAgentCallKey(
  parentSessionId: string,
  args: OrchestrationCreateAgentArgs,
): string {
  const fields: Record<keyof OrchestrationCreateAgentArgs, unknown> = {
    kind: args.kind ?? null,
    providerRuntime: args.providerRuntime ?? null,
    prompt: args.prompt ?? null,
    cwd: args.cwd ?? null,
    title: args.title ?? null,
    role: args.role ?? null,
    runId: args.runId ?? null,
    inheritParentContext: false,
    builtInMcpDomains: [...(args.builtInMcpDomains ?? [])].sort(),
  }
  return JSON.stringify([
    parentSessionId,
    ...Object.keys(fields).sort().map(name => fields[name as keyof typeof fields]),
  ])
}

  server.registerTool(
    'orchestration_create_agent',
    {
      title: 'Create Orchestration Agent',
      description:
        [
          'Creates a distinct Agent Code orchestration child agent in Dispatch, optionally bootstrapped with an initial prompt.',
          'Use this only when the user explicitly asks for delegated, parallel, or orchestrated agent work.',
          'The child currently starts from a clean provider conversation; include any necessary parent context directly in the prompt.',
          'Choose providerRuntime: "terminal" when the owner or user wants the provider\'s native TUI in the pane; the provider must support that runtime. Omit providerRuntime for the default structured runtime.',
        ].join(' '),
      inputSchema: ORCHESTRATION_CREATE_AGENT_INPUT,
    },
    async requested => {
      // Review round 2 (#1143): a child may not be handed a privileged domain
      // its parent does not hold itself. Orchestration is on by default, so
      // without this any ordinary agent — or a prompt injection reaching one —
      // could spawn a child with mcp_servers (and install a server every
      // future agent runs) or root_management (skipping its confirmation
      // dialog). Clamped here, at the one place a model-chosen list enters.
      const args = {
        ...requested,
        ...(requested.builtInMcpDomains
          ? { builtInMcpDomains: requested.builtInMcpDomains.filter(domain =>
              !PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS.has(domain) || scope.domains.includes(domain)) }
          : {}),
      }
      const bridge = dependencies.orchestrationBridge
      const manager = dependencies.sessionManager
      if (!bridge || !manager) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }

      // One identical call at a time (#952). The whole invocation is the unit:
      // create, deliver the bootstrap prompt and mark it delivered are one
      // operation from the caller's side, and a duplicate must receive this
      // call's RESULT rather than start a second child or collide with the
      // first one's prompt delivery. `OrchestrationBridge.createCallsInFlight`
      // carries the full reasoning, including why the prompt is in the key.
      return await bridge.createAgentCallOnce(
        orchestrationCreateAgentCallKey(scope.sessionId, args),
        async () => {
        const agent = await bridge.createAgent({
          parentSessionId: scope.sessionId,
          kind: args.kind as OrchestrationAgentKind,
          ...(args.providerRuntime ? { providerRuntime: args.providerRuntime } : {}),
          cwd: args.cwd,
          title: args.title,
          role: args.role,
          runId: args.runId,
          // WHY force clean children even if an older tool caller passes true:
          // the inheritance implementation is intentionally disabled in this PR.
          // Keeping the schema field avoids breaking stale provider tool caches,
          // but honoring it would re-enable the broken clone/translate path.
          inheritParentContext: false,
          builtInMcpDomains: args.builtInMcpDomains as BuiltInMcpDomain[] | undefined,
        })

        if (args.prompt && args.prompt.trim().length > 0) {
          const prompt = buildOrchestrationBootstrapPrompt({
            task: args.prompt,
          })
          const delivery = await manager.deliverPromptToAgent(agent.sessionId, prompt)
          // A child that is not ready YET is not a failed child (#854).
          //
          // The run journal is unambiguous about which failure this is: of 55
          // recorded bootstrap failures, 26 were "blocked by
          // claude.trust-dialog" — the first-launch prompt an orchestration
          // child in a fresh worktree hits every time, answered by a human in
          // their own time — and 21 were "still warming
          // (composer-unpainted)". Both clear on their own. Only 5 ever
          // reached the absorption stage, so the large prompts this was blamed
          // on were not the cause.
          //
          // Reporting those as an error made the caller's situation strictly
          // worse: the disposition said `retry-same-session`, the parent
          // retried immediately into the same not-ready window, and THAT
          // attempt is the one that writes prompt bytes without Enter and
          // leaves an orphaned draft the parent can only escape by closing the
          // child. So instead the prompt waits for the composer, and the reply
          // says so — the child is created, the brief is coming, and the
          // parent is told not to send it again.
          //
          // The gate checks, the arming and the landing bookkeeping live in
          // `armPromptWhenReady`, shared with `orchestration_send_prompt`
          // (#1134) so the two paths cannot drift on the parts that decide
          // whether a promise to the parent is kept.
          if (!delivery.ok && armPromptWhenReady({
            dependencies,
            bridge,
            manager,
            parentSessionId: scope.sessionId,
            sessionId: agent.sessionId,
            prompt,
            delivery,
            // A create_agent prompt is always the bootstrap.
            markBootstrapOnLanding: true,
            incidentReason: 'create_agent_bootstrap_pending',
            // Nothing can be waiting yet for a child that did not exist a
            // moment ago, and a refusal here would be a real double-arm.
            supersedesPendingPrompt: false,
          })) {
            return toolText({
              ok: true,
              agent,
              // Not submitted, and not lost: the distinction the old reply
              // could not make.
              promptSubmitted: false,
              promptPending: true,
              promptPendingReason: delivery.message,
              message: `The child was created and its prompt is waiting for its composer (${delivery.message}). It will be delivered as soon as the child can accept it — do not send it again; use orchestration_read_agent to see when it lands.`,
            })
          }
          if (!delivery.ok) {
            let cleanupAttempted = false
            let agentClosed = false
            let cleanupError: string | undefined
            // Duplicate safety and child health are independent. A warming
            // timeout or trust dialog is safe to retry after recovery but the
            // child is still valuable; deleting every retry-safe child turned a
            // transient startup delay into permanent session loss. Only an
            // explicit provider verdict that this session cannot be used again
            // authorizes cleanup.
            if (delivery.disposition === 'session-unusable') {
              try {
                cleanupAttempted = true
                const cleanup = await bridge.closeAgent({
                  parentSessionId: scope.sessionId,
                  sessionId: agent.sessionId,
                })
                agentClosed = cleanup.closedSessionIds.includes(agent.sessionId)
              } catch (err) {
                cleanupError = err instanceof Error && err.message.length > 0
                  ? err.message
                  : 'Unknown orchestration cleanup failure.'
              }
            }
            dependencies.appRunJournal?.recordIncident({
              kind: 'orchestration.prompt_delivery_failed',
              severity: 'error',
              reason: 'create_agent_bootstrap',
              context: {
                sessionId: agent.sessionId,
                message: delivery.message,
                stage: delivery.stage,
                code: delivery.code,
                retrySafe: delivery.retrySafe,
                disposition: delivery.disposition,
                promptWritten: delivery.promptWritten,
                enterWritten: delivery.enterWritten,
                cleanupAttempted,
                agentClosed,
                cleanupError,
              },
            })
            return toolText({
              ok: false,
              error: 'prompt_delivery_failed',
              message: delivery.message,
              retrySafe: delivery.retrySafe,
              disposition: delivery.disposition,
              // WHY omit the live agent object on bootstrap failure:
              // `create_agent` is a two-step operation. By this point the
              // renderer has already created a real provider session with PTY,
              // proxy, JSONL watchers, and scoped MCP registration, but the
              // caller receives an error and usually abandons the handle. Returning
              // the full agent here made that half-created child look usable while
              // leaving cleanup to memory and luck. The failure result now reports
              // the session id plus cleanup outcome, and the child is best-effort
              // closed before the error crosses the MCP boundary only when no
              // bytes were written and the provider explicitly says the session
              // itself is unusable. Retry safety alone intentionally preserves
              // warming and user-resolvable children.
              sessionId: agent.sessionId,
              cleanupAttempted,
              agentClosed,
              cleanupError,
              // `false` is only truthful when no bytes crossed the boundary.
              // Omit it for uncertainty so an orchestrator cannot interpret a
              // late acknowledgement as permission to duplicate the task.
              ...(delivery.retrySafe
                ? { promptSubmitted: false }
                : { promptSubmission: 'uncertain' as const }),
            })
          }
          bridge.notePromptSubmitted(agent.sessionId)
          try {
            return toolText({
              ok: true,
              agent: await bridge.markBootstrapPromptDelivered({
                parentSessionId: scope.sessionId,
                sessionId: agent.sessionId,
              }),
              promptSubmitted: true,
            })
          } catch (err) {
            return toolText({
              ok: true,
              agent,
              promptSubmitted: true,
              bootstrapPromptDelivered: true,
              bootstrapPromptPersistenceWarning: err instanceof Error && err.message.length > 0
                ? err.message
                : 'Could not persist orchestration bootstrap delivery state.',
            })
          }
        }

        return toolText({
          ok: true,
          agent: (await bridge.listAgents({ parentSessionId: scope.sessionId, runId: args.runId }).catch(() => [agent]))
            .find(item => item.sessionId === agent.sessionId) ?? agent,
          promptSubmitted: Boolean(args.prompt && args.prompt.trim().length > 0),
        })
        },
      )
    },
  )

  server.registerTool(
    'orchestration_send_prompt',
    {
      title: 'Send Prompt To Orchestration Agent',
      // WHY the pending contract is in the description (#1134): the reply's
      // `message` says it too, but a model deciding whether to call this tool
      // AGAIN reads the description first, and "a newer prompt replaces a
      // waiting one" is the rule it must know before it sends a second one.
      description:
        [
          'Sends a follow-up prompt to an existing orchestration-created Agent Code session.',
          'If the agent cannot take a prompt yet (still starting, waiting on a dialog, or busy with a turn) and its provider supports waiting, the prompt waits and the reply says promptPending: true; it lands when the agent is ready (after the current turn, for a busy agent). Do not send it again; orchestration_wait_agents keeps waiting while it is pending.',
          'Providers that cannot wait return prompt_delivery_failed instead, and that prompt was not sent.',
          'Sending another prompt to the same agent while one is waiting replaces the waiting one, and the reply says supersededPendingPrompt: true.',
        ].join(' '),
      inputSchema: {
        sessionId: z.string(),
        prompt: z.string().refine(value => value.trim().length > 0, {
          message: 'Prompt must not be empty.',
        }),
      },
    },
    async args => {
      const manager = dependencies.sessionManager
      const bridge = dependencies.orchestrationBridge
      if (!manager || !bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      let output: OrchestrationAgentOutput
      try {
        output = await bridge.readAgent({
          parentSessionId: scope.sessionId,
          sessionId: args.sessionId,
          maxMessages: 1,
        })
      } catch (err) {
        return toolText({
          ok: false,
          error: 'orchestration_agent_not_owned',
          message: err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not read orchestration agent owned by this parent.',
          sessionId: args.sessionId,
        })
      }
      if (output.agent.lifecycleState === 'closed') {
        return toolText({
          ok: false,
          error: 'orchestration_agent_closed',
          message: `Cannot send orchestration prompt to closed agent ${args.sessionId}`,
          sessionId: args.sessionId,
        })
      }
      try {
        await bridge.ensureAgentLive({
          parentSessionId: scope.sessionId,
          sessionId: args.sessionId,
        })
      } catch (err) {
        return toolText({
          ok: false,
          error: 'agent_wake_failed',
          message: err instanceof Error && err.message.length > 0
            ? err.message
            : `Could not wake orchestration agent ${args.sessionId} before prompt delivery.`,
          sessionId: args.sessionId,
        })
      }
      const kind = manager.getSessionKind(args.sessionId)
      if (!isAgentProviderKind(kind)) {
        return toolText({
          ok: false,
          error: 'not_agent_session',
          message: `Cannot send orchestration prompt to non-agent session ${args.sessionId}`,
          sessionId: args.sessionId,
        })
      }
      const shouldWrap = output.agent.orchestrationBootstrapPromptDelivered !== true
      const prompt = shouldWrap
        ? buildOrchestrationBootstrapPrompt({
            task: args.prompt.trim(),
          })
        : args.prompt.trim()
      // `supersedesPendingPrompt` (#854 review): THIS caller is sending the
      // child's brief by hand, so a brief still waiting for the composer is
      // the same task and must not arrive twice. Every other delivery path —
      // a human typing in the pane, the phone, the goal loop, compaction — is
      // writing something else and leaves the waiting brief alone.
      //
      // Since #1134 the waiting prompt can also be an EARLIER send_prompt
      // that went pending, and the rule is the same: the newest orchestration
      // prompt wins, and at most one waits per session. The alternatives were
      // worse — refusing a second send while one waits leaves a parent unable
      // to correct a brief stuck behind a trust dialog without closing the
      // child (and contradicts the create_agent → send_prompt rule above),
      // and queueing both hands the child two tasks back-to-back with no
      // ordering contract. What "latest wins" costs is that a DIFFERENT
      // follow-up replaces the earlier one, so the reply says when that
      // happened (`supersededPendingPrompt`), detected from the manager's
      // `pending-superseded` record — emitted only when a waiter was really
      // cancelled, never for one that had already started delivering.
      let supersededPendingPrompt = false
      const delivery = await manager.deliverPromptToAgent(
        args.sessionId, prompt, undefined,
        event => { if (event === 'pending-superseded') supersededPendingPrompt = true },
        undefined,
        { supersedesPendingPrompt: true },
      )
      const superseded = supersededPendingPrompt ? { supersededPendingPrompt: true } : {}
      // A child that is not ready YET (#1134): the same wait create_agent got
      // in #854, for the same reason. The recorded corpus's largest single
      // failure group is 36 `send_prompt / before-write / not-ready /
      // retry-same-session` — a child waking from park or sitting behind a
      // first-launch trust dialog — and the old reply's `retry-same-session`
      // sent the parent straight back into that window, which is the retry
      // that orphans a half-written draft.
      //
      // `supersedesPendingPrompt: true` on the ARM as well as on the direct
      // attempt: the direct attempt cancelled any earlier waiter, but that
      // waiter leaves the map only when its loop unwinds, and a gate that
      // answers "blocked" synchronously can bring us here first. Without it
      // this waiter would be refused as a duplicate right after the reply
      // below promised the parent `promptPending: true`.
      const armed = delivery.ok ? null : armPromptWhenReady({
        dependencies,
        bridge,
        manager,
        parentSessionId: scope.sessionId,
        sessionId: args.sessionId,
        prompt,
        delivery,
        // Only a wrapped prompt is the bootstrap. Marking a follow-up would
        // be a lie in the other direction for nobody's benefit, and marking
        // BEFORE landing would make every later send_prompt skip the handoff
        // wrapper for a child that never received one.
        markBootstrapOnLanding: shouldWrap,
        incidentReason: 'send_prompt_pending',
        supersedesPendingPrompt: true,
      })
      if (armed && !delivery.ok) {
        return toolText({
          ok: true,
          sessionId: args.sessionId,
          promptSubmitted: false,
          promptPending: true,
          promptPendingReason: delivery.message,
          // Either supersede counts: the direct attempt's, or the arm's
          // (a waiter that armed while the direct attempt was in the provider).
          ...(supersededPendingPrompt || armed.supersededPendingPrompt
            ? { supersededPendingPrompt: true }
            : {}),
          // WHY the wording names "busy" (#1134 review): a Codex child
          // mid-turn answers not-ready too, and for it the prompt lands after
          // the current turn, not after a startup — a parent reading
          // "starting" would misjudge how long it waits.
          message: `The agent cannot take a prompt yet (${delivery.message}), so the prompt is waiting: it will be delivered as soon as the agent can accept it — after it finishes starting, after a dialog is answered, or after its current turn if it is busy. Do not send it again. orchestration_wait_agents treats the agent as working until the prompt lands and it answers; orchestration_read_agent shows promptSubmitted once it lands. Sending another prompt to this agent before then REPLACES this one.`,
        })
      }
      if (!delivery.ok) {
        dependencies.appRunJournal?.recordIncident({
          kind: 'orchestration.prompt_delivery_failed',
          severity: 'error',
          reason: 'send_prompt',
          context: {
            sessionId: args.sessionId,
            message: delivery.message,
            stage: delivery.stage,
            code: delivery.code,
            disposition: delivery.disposition,
            retrySafe: delivery.retrySafe,
            promptWritten: delivery.promptWritten,
            enterWritten: delivery.enterWritten,
          },
        })
        return toolText({
          ok: false,
          error: 'prompt_delivery_failed',
          message: delivery.message,
          retrySafe: delivery.retrySafe,
          stage: delivery.stage,
          code: delivery.code,
          disposition: delivery.disposition,
          promptWritten: delivery.promptWritten,
          enterWritten: delivery.enterWritten,
          promptSubmission: delivery.retrySafe ? 'not-submitted' : 'uncertain',
          sessionId: args.sessionId,
          // Even a failed send may have replaced a waiting prompt: the
          // supersede runs before the provider attempt. The parent has to
          // know the earlier one is gone before it decides what to resend.
          ...superseded,
        })
      }
      bridge.notePromptSubmitted(args.sessionId)
      if (shouldWrap) {
        try {
          await bridge.markBootstrapPromptDelivered({
            parentSessionId: scope.sessionId,
            sessionId: args.sessionId,
          })
        } catch (err) {
          return toolText({
            ok: true,
            sessionId: args.sessionId,
            bootstrapPromptDelivered: true,
            bootstrapPromptPersistenceWarning: err instanceof Error && err.message.length > 0
              ? err.message
              : 'Could not persist orchestration bootstrap delivery state.',
            ...superseded,
          })
        }
      }
      return toolText({ ok: true, sessionId: args.sessionId, ...superseded })
    },
  )

  server.registerTool(
    'orchestration_list_agents',
    {
      title: 'List Orchestration Agents',
      description:
        'Lists orchestration-created child agents for this parent session, optionally filtered by run id.',
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      if (!bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      const agents = await bridge.listAgents({
        parentSessionId: scope.sessionId,
        runId: args.runId,
      })
      return toolText({ ok: true, agents })
    },
  )

  server.registerTool(
    'orchestration_read_agent',
    {
      title: 'Read Orchestration Agent Output',
      description:
        'Reads clean user-visible output from one orchestration-created child agent. Returns visible messages and latest/final assistant text without provider-internal event noise. Message text is byte-capped (defaults: 4000 chars per message, 24000 per agent); truncated/totalChars fields flag excerpts. To recover truncated content, re-read with explicit larger maxCharsPerMessage/maxCharsPerAgent, or read the full disk-backed transcript with agent_transcript_read_file.',
      inputSchema: {
        sessionId: z.string(),
        maxMessages: z.number().int().min(1).max(100).optional(),
        // Ranges match the agent_transcript_* tools so the same numbers mean
        // the same thing on both consumption surfaces (#373).
        maxCharsPerMessage: z.number().int().min(50).max(100_000).optional(),
        maxCharsPerAgent: z.number().int().min(100).max(500_000).optional(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      if (!bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      let readError: unknown = null
      const output = await bridge.readAgent({
        parentSessionId: scope.sessionId,
        sessionId: args.sessionId,
        maxMessages: args.maxMessages,
        maxCharsPerMessage: args.maxCharsPerMessage,
        maxCharsPerAgent: args.maxCharsPerAgent,
      }).catch(err => {
        readError = err
        return null
      })
      if (!output) {
        return toolText({
          ok: false,
          error: 'orchestration_read_failed',
          message: readError instanceof Error && readError.message.length > 0
            ? readError.message
            : 'Could not read orchestration agent output.',
        })
      }
      return toolText({ ok: true, output })
    },
  )

  server.registerTool(
    'orchestration_read_run_outputs',
    {
      title: 'Read Orchestration Run Outputs',
      description:
        'Reads clean user-visible outputs from every orchestration child agent in this parent session, optionally filtered by run id. Outputs are byte-capped per message/agent and share a cross-agent total budget; over-budget agents degrade to status summaries with short excerpts and truncated=true. To recover a truncated agent, re-read it with orchestration_read_agent and explicit larger caps, or use agent_transcript_read_file on its transcript.',
      inputSchema: {
        runId: z.string().optional(),
        maxMessagesPerAgent: z.number().int().min(1).max(100).optional(),
        maxCharsPerMessage: z.number().int().min(50).max(100_000).optional(),
        maxCharsPerAgent: z.number().int().min(100).max(500_000).optional(),
        maxTotalChars: z.number().int().min(1_000).max(2_000_000).optional(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      if (!bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      const outputs = await bridge.readRunOutputs({
        parentSessionId: scope.sessionId,
        runId: args.runId,
        maxMessagesPerAgent: args.maxMessagesPerAgent,
        maxCharsPerMessage: args.maxCharsPerMessage,
        maxCharsPerAgent: args.maxCharsPerAgent,
      })
      const bounded = boundOutputsToTotalChars(outputs, args.maxTotalChars)
      return toolText({
        ok: true,
        outputs: bounded.outputs,
        ...(bounded.truncated ? { truncated: true } : {}),
      })
    },
  )

  server.registerTool(
    'orchestration_wait_agents',
    {
      title: 'Wait For Orchestration Agents',
      description:
        `Waits for all matching orchestration-created child agents to leave active states, then returns their statuses and latest outputs. ONE CALL STOPS WAITING AFTER ${WAIT_AGENTS_MAX_WAIT_MS / 1000} SECONDS whatever timeoutMs asks for, then reads outputs once and replies; when it is cut short the reply carries done=false and, if any of your budget is left, remainingMs — call this again with that value to keep waiting. A cut-short reply can also carry outputsUnavailable=true, meaning the agents are reported but their outputs were not read in time; get them with orchestration_read_run_outputs. Outputs are byte-capped per message/agent and share a cross-agent total budget; over-budget agents degrade to status summaries with short excerpts and truncated=true. To recover a truncated agent, re-read it with orchestration_read_agent and explicit larger caps, or use agent_transcript_read_file on its transcript.`,
      inputSchema: {
        runId: z.string().optional(),
        sessionIds: z.array(z.string()).optional(),
        timeoutMs: z.number().int().min(1000).max(600000).default(30000)
          .describe(`How long you want to wait in total. One call stops waiting after ${WAIT_AGENTS_MAX_WAIT_MS / 1000} s; a larger value returns done=false with remainingMs, which is what you pass to the next call.`),
        pollIntervalMs: z.number().int().min(250).max(10000).default(1000),
        maxMessagesPerAgent: z.number().int().min(1).max(100).optional(),
        maxCharsPerMessage: z.number().int().min(50).max(100_000).optional(),
        maxCharsPerAgent: z.number().int().min(100).max(500_000).optional(),
        maxTotalChars: z.number().int().min(1_000).max(2_000_000).optional(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      if (!bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      // WHY one call never waits the full requested timeout (#827): a
      // foreground MCP tool call whose transport stops listening loses its
      // reply outright. The children are unaffected, so the work is fine; what
      // is gone is the caller's only record of it, and the flow falls back to
      // polling `orchestration_list_agents` with no idea that is what
      // happened. See WAIT_AGENTS_MAX_WAIT_MS for which numbers here are
      // measured and which hazard this does NOT close.
      //
      // The reply already carried `done`, so the polling shape existed. This
      // keeps the reply inside a window it can still be received in, and says
      // `remainingMs` so the caller knows to call again — with a budget it does
      // not have to compute — rather than concluding the children are stuck.
      const startedAt = Date.now()
      const cappedTimeoutMs = Math.min(args.timeoutMs, WAIT_AGENTS_MAX_WAIT_MS)
      // Before the first `listAgents`, deliberately: that call is a round trip
      // through the bridge, which serializes every orchestration request
      // app-wide behind one in-flight slot and puts NO timer on the queue wait
      // (the bridge's 30 s `TIMEOUT_MS` starts only once dispatch is granted).
      // Starting the clock after it would let that wait be added to the cap
      // rather than spent inside it.
      const deadline = startedAt + cappedTimeoutMs
      // One deadline for the WHOLE call, raced against every bridge read —
      // not a bound on the sleeps between them.
      //
      // WHY the clamped sleep is not enough (#1089 review, round 2): the loop
      // checks the deadline before the sleep and never during an `await`, so
      // clamping the sleep alone left each `listAgents` free to run past it.
      // Measured, with a bridge under the contention its own comments describe
      // ("with 20 orchestrated children it is common for several wait/list
      // calls to poll the same parent/run during the same quarter-second"):
      // one call took 87,250 ms against a 30 s promise — past the SDK's 60 s
      // default request timeout, which is the reported bug reproduced by its
      // own fix.
      //
      // This is the shape `observations.wait` already uses
      // (`src/main/control/waits.ts`), including its accepted cost: losing the
      // race leaves a read in flight, because the bridge has no cancellation.
      // Nothing is retried and nothing is mutated by these reads, so a
      // stranded one costs a slot for its own duration and no more.
      let expired = false
      let stopWaiting!: () => void
      const expiry = new Promise<typeof EXPIRED>(resolve => {
        stopWaiting = () => resolve(EXPIRED)
      })
      const expiryTimer = setTimeout(() => { expired = true; stopWaiting() }, cappedTimeoutMs)
      // The measured cost of a bridge round trip on THIS call, used as the
      // reserve the poll loop leaves for the final `readRunOutputs`. A fixed
      // reserve would be another invented number; the last read's own duration
      // is the only honest estimate available, and it grows automatically
      // exactly when the bridge is congested.
      let bridgeCostMs = 0
      const withDeadline = async <T>(operation: Promise<T>): Promise<T | typeof EXPIRED> => {
        const calledAt = Date.now()
        const result = await Promise.race([operation, expiry])
        bridgeCostMs = Math.max(bridgeCostMs, Date.now() - calledAt)
        return result
      }
      const scopeAgents = (list: OrchestrationAgentRecord[]): OrchestrationAgentRecord[] => {
        if (!args.sessionIds || args.sessionIds.length === 0) return list
        const wanted = new Set(args.sessionIds)
        return list.filter(agent => wanted.has(agent.sessionId))
      }

      try {
        // `null` means NO READ SUCCEEDED, which is not the same as "no agents
        // matched" and must never be reported as `done`. An empty list from a
        // real read still means the run is finished; an empty list because the
        // read lost the race means we know nothing.
        let agents: OrchestrationAgentRecord[] | null = null
        const first = await withDeadline(bridge.listAgents({ parentSessionId: scope.sessionId, runId: args.runId }))
        if (first !== EXPIRED) agents = scopeAgents(first)
        while (
          !expired
          && agents !== null
          && agents.some(agent => isOrchestrationAgentActive(agent.lifecycleState))
          // Stop polling once what is left would not cover another round trip
          // plus the final read. Without this the loop spends the entire
          // budget on polling and the reply's outputs are always the thing
          // that gets dropped.
          && Date.now() + bridgeCostMs * 2 < deadline
        ) {
          // Clamped to what is LEFT, not the raw interval. `pollIntervalMs` is
          // schema-legal up to 10 s, so an unclamped sleep overshot the cap by
          // a whole interval: measured 90_010 ms against a 90_000 ms cap.
          await sleep(Math.min(args.pollIntervalMs, Math.max(0, deadline - Date.now())))
          const next = await withDeadline(bridge.listAgents({ parentSessionId: scope.sessionId, runId: args.runId }))
          if (next === EXPIRED) break
          // The scope is re-applied on EVERY poll, not only the first read: a
          // child created after the call started would otherwise join the set
          // the caller explicitly named, and its activity would keep a
          // `sessionIds` wait running past the agents it asked about.
          agents = scopeAgents(next)
        }
        const agentIds = new Set((agents ?? []).map(agent => agent.sessionId))
        const read = agents === null
          ? EXPIRED
          : await withDeadline(bridge.readRunOutputs({
            parentSessionId: scope.sessionId,
            runId: args.runId,
            maxMessagesPerAgent: args.maxMessagesPerAgent,
            maxCharsPerMessage: args.maxCharsPerMessage,
            maxCharsPerAgent: args.maxCharsPerAgent,
          }))
        const outputs = read === EXPIRED
          ? []
          : read.filter(output => agentIds.has(output.agent.sessionId))
        // The `agents` status array below is part of the same tool response, so
        // its JSON size is charged against maxTotalChars as reservedChars —
        // otherwise wait_agents' real payload would exceed the budget by
        // exactly the part the budget was never told about (#510 review).
        // Status records carry no message bodies, so this reservation is small
        // and proportional to agent count, not output size.
        const bounded = boundOutputsToTotalChars(
          outputs,
          args.maxTotalChars,
          JSON.stringify(agents ?? []).length,
        )
        // `done` requires a read that actually happened. A list we never got
        // is empty, and an empty list otherwise means "the run has finished" —
        // the exact shape that tells a parent every child is done while one is
        // still working.
        const done = agents !== null && !agents.some(agent => isOrchestrationAgentActive(agent.lifecycleState))
        const elapsedMs = Date.now() - startedAt
        const remainingMs = Math.max(0, args.timeoutMs - elapsedMs)
        return toolText({
          ok: true,
          done,
          agents: agents ?? [],
          outputs: bounded.outputs,
          // Only when the cap actually cut the wait short, there is still
          // something to wait for, and what is left is a LEGAL next
          // `timeoutMs`. Reporting it on a completed run would tell the caller
          // to call again for children that are already done.
          //
          // The caller's UNSPENT budget, not the cap: reporting the cap made
          // the caller reconstruct "how much of what I asked for is left" from
          // an argument it had to remember. It is computed from real elapsed
          // time, so the final read's cost comes out of that budget instead of
          // vanishing from it.
          //
          // WHY the schema minimum is the floor for reporting it (#1089
          // review, round 2): `timeoutMs` is `min(1000)`, and the description
          // tells the caller to pass this straight back. A remainder of 500 —
          // reachable from any `timeoutMs` whose remainder mod the cap lands
          // under a second — then walked the documented recovery path into a
          // hard `-32602` validation error. Omitting it says the same thing
          // the `timeoutMs <= cap` case already says: your budget is spent.
          ...(!done && cappedTimeoutMs < args.timeoutMs && remainingMs >= MIN_WAIT_AGENTS_TIMEOUT_MS
            ? { remainingMs }
            : {}),
          // The call hit its own deadline with reads still outstanding. Said
          // out loud because the reply is PARTIAL: without this a caller
          // cannot tell "no outputs, the children produced none" from "no
          // outputs, we ran out of time before reading them".
          ...(agents === null ? { agentsUnavailable: true } : {}),
          ...(read === EXPIRED && agents !== null ? { outputsUnavailable: true } : {}),
          ...(bounded.truncated ? { truncated: true } : {}),
        })
      } finally {
        // Always: an early return or a throw would otherwise leave a 30 s
        // timer holding the event loop open after the reply was sent.
        clearTimeout(expiryTimer)
      }
    },
  )

  server.registerTool(
    'orchestration_close_agent',
    {
      title: 'Close Orchestration Agent',
      description:
        'Closes one orchestration-created child agent owned by this parent session. It cannot close unrelated workspace sessions.',
      inputSchema: {
        sessionId: z.string(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      if (!bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      const result = await bridge.closeAgent({
        parentSessionId: scope.sessionId,
        sessionId: args.sessionId,
      })
      return toolText({ ok: true, ...result })
    },
  )

  server.registerTool(
    'orchestration_close_run',
    {
      title: 'Close Orchestration Run',
      description:
        'Closes every orchestration-created child agent owned by this parent session, optionally filtered by run id. It cannot close unrelated workspace sessions.',
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      if (!bridge) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }
      const result = await bridge.closeRun({
        parentSessionId: scope.sessionId,
        runId: args.runId,
      })
      return toolText({ ok: true, ...result })
    },
  )
}

// WHY 30 s and not the schema's 600 s maximum (#827): a foreground MCP tool
// call has to return while its transport is still listening.
//
// WHAT IS MEASURED, and what is not. The first version of this cap was 90 s,
// justified by "Claude Code backgrounds a tool call at 120 s". Review could
// not find that threshold anywhere, and the vendored source says the opposite:
// `vendor/claude-code-src/full/services/mcp/client.ts:211` sets
// `DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000` (~27.8 h) and passes it at the
// `callTool` site; backgrounding there belongs to shell and agent tasks, not
// to MCPTool. So that number was invented, and a cap derived from it was a
// guess wearing a fact's clothing.
//
// These are the numbers that are real, each checked in the tree:
//
//   - `@modelcontextprotocol/sdk` … /shared/protocol.js:8 —
//     `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, applied as
//     `options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`. ANY client that does
//     not override it kills the request at 60 s. This is the binding
//     constraint, and the 90 s cap sat ABOVE it: the old cap turned an
//     occasional loss into a guaranteed one for such a client. Claude Code
//     overrides (above) and Codex uses 300 s
//     (`vendor/codex-src/codex-rs/codex-mcp/src/rmcp_client.rs`), but
//     `opencode` and `grok` also receive the `orchestration` domain and their
//     client timeouts are NOT known — a compiled binary, not readable source.
//     So the cap has to assume the default.
//   - This repo already bounds its other long-poll at 30 s
//     (`workflow_run_events`' `waitMs: …max(30_000)`), and the control
//     capability `observations.wait` at 10 s. 30 s is the house number for
//     "a tool call that blocks while a transport listens".
//
// 30 s therefore leaves half the SDK's default budget for the final
// `readRunOutputs` round trip, which the bridge bounds at its own 30 s
// (`OrchestrationBridge` TIMEOUT_MS).
//
// WHAT THIS DOES NOT FIX, stated so nobody mistakes the cap for a cure: the
// reported drop is not clock-triggered. Our POST replies are SSE streams
// (`BuiltInMcpHttpHost` builds `StreamableHTTPServerTransport` with no
// `eventStore` and no `enableJsonResponse`), that stream carries ZERO bytes
// for the whole call, and with no event store it is not resumable — so when a
// client's SSE reconnects are exhausted the reply is gone for good. A shorter
// wait shortens the exposure window; it does not close it. The mechanism fixes
// are progress notifications or `enableJsonResponse: true`, neither verified
// here — see #1091. Progress extends a client's timer only when that client
// OPTS IN (`resetTimeoutOnProgress`, default false in the SDK): OpenCode does,
// Claude Code does not. So it is a partial mitigation, not the cure it first
// looked like.
//
// It is a CAP, not a new maximum: `timeoutMs` still accepts up to 600 s
// because the number the caller passes is what it wants in total, and the
// reply says when a call was cut short. Lowering the schema bound instead
// would make every existing caller's request invalid rather than shorter.
const WAIT_AGENTS_MAX_WAIT_MS = 30_000

/**
 * The schema's own floor for `timeoutMs`, named once so the handler can refuse
 * to hand a caller a `remainingMs` the schema would then reject (#1089 review).
 */
const MIN_WAIT_AGENTS_TIMEOUT_MS = 1_000

/**
 * "This read lost the race against the call's deadline."
 *
 * A unique symbol rather than null/undefined because a bridge read can
 * legitimately resolve to an empty array, and the difference between "no
 * agents" and "we never found out" is what decides whether the reply may say
 * `done`.
 */
const EXPIRED = Symbol('wait-agents-expired')

/**
 * Is this delivery failure "not ready YET" — a state that clears without
 * anyone acting on the orchestration side (#854)?
 *
 * `retry-same-session` is a warming composer; `retry-after-resolve` is a gate
 * something else has to clear, which in the recorded corpus is almost always
 * Claude's first-launch trust dialog. Both are the prompt arriving early.
 *
 * Everything else — a session the provider calls unusable, an absorption or
 * acceptance failure — is a real failure about a real attempt and must keep
 * failing loudly. The `stage` check is what excludes those.
 *
 * The bytes check in front of it is DEFENCE IN DEPTH and unreachable today:
 * review enumerated every `ok: false` shape the four provider paths can
 * produce and none carries `stage: 'before-write'` together with written
 * bytes. It stays because the consequence of the two ever meeting is a second
 * copy of the same prompt — the orphaned-draft half of #854 rather than a fix
 * for it — and a future provider that writes before it decides it is not ready
 * would otherwise inherit that silently.
 */
function isNotReadyYet(delivery: Extract<PromptDeliveryResult, { ok: false }>): boolean {
  if (delivery.promptWritten || delivery.enterWritten) return false
  // The stage check is also what keeps the RESERVATION refusal out (#1134
  // review). `delivery-in-flight` carries `disposition: retry-same-session`
  // too, but it means another delivery to this child is running right now —
  // quite possibly a waiter delivering this very brief. Treating that as "not
  // ready yet" would queue a second copy behind it; it must stay a failure
  // the parent sees. It has `stage: 'reservation'`, so it stops here.
  if (delivery.stage !== 'before-write') return false
  return delivery.disposition === 'retry-same-session' || delivery.disposition === 'retry-after-resolve'
}

/**
 * Hold an orchestration prompt for a child that is not ready YET, and keep the
 * books when it lands (#854, shared with send_prompt in #1134).
 *
 * Returns an object when the prompt is now waiting — the caller then owes the
 * parent a `promptPending: true` reply and must not report a failure, and
 * `supersededPendingPrompt` says whether arming replaced a waiting prompt.
 * Returns `null` when this is not a wait-able failure, and the caller replies
 * exactly as it did before the wait existed.
 *
 * WHY one helper for both tools: create_agent and send_prompt differ in their
 * REPLIES (create returns the agent, send returns the session id), but the
 * parts that decide whether a promise to the parent is kept must be the same
 * code — which failures count as "early", which providers can be waited on,
 * when the bootstrap is marked, what is journaled. Two copies of that is how
 * one of them ends up marking the bootstrap before it lands.
 *
 * WHY `canWaitForPromptReadiness` decides BEFORE anything is promised (#854
 * review): only Claude and Codex have a readiness gate to subscribe to.
 * OpenCode and Grok report not-readiness as an ordinary failure, so promising
 * a wait there replaced a retry the parent could act on with a silent loss it
 * could not. For them this returns `false` and the old failure reply stands.
 */
function armPromptWhenReady(input: {
  dependencies: BuiltInMcpDependencies
  bridge: NonNullable<BuiltInMcpDependencies['orchestrationBridge']>
  manager: NonNullable<BuiltInMcpDependencies['sessionManager']>
  parentSessionId: string
  sessionId: string
  prompt: string
  delivery: Extract<PromptDeliveryResult, { ok: false }>
  /**
   * Mark `orchestrationBootstrapPromptDelivered` when the prompt lands. Only
   * when the prompt IS the bootstrap (create_agent always; send_prompt when it
   * wrapped). Never before landing: every later send_prompt reads that flag
   * to decide whether to wrap, so an early mark means a child that never got
   * its handoff never gets it.
   */
  markBootstrapOnLanding: boolean
  /** Journal reason for a wait that ends without a delivery. */
  incidentReason: 'create_agent_bootstrap_pending' | 'send_prompt_pending'
  /** See `SessionManager.deliverPromptWhenReady`'s option of the same name. */
  supersedesPendingPrompt: boolean
}): { supersededPendingPrompt: boolean } | null {
  const { dependencies, bridge, manager, delivery, sessionId } = input
  if (
    !isNotReadyYet(delivery)
    || typeof manager.deliverPromptWhenReady !== 'function'
    || manager.canWaitForPromptReadiness?.(sessionId) !== true
  ) {
    return null
  }
  // The manager reports a replaced waiter synchronously, before its first
  // await, so this is settled by the time the call below returns.
  let supersededPendingPrompt = false
  const pending = manager.deliverPromptWhenReady(
    sessionId,
    input.prompt,
    event => { if (event === 'pending-superseded') supersededPendingPrompt = true },
    input.supersedesPendingPrompt ? { supersedesPendingPrompt: true } : undefined,
  )
  // Visible to `list_agents` / `wait_agents` as `prompt_sent` until it
  // settles (#1134 review) — see `PromptDeliveryMetadata.pendingPrompt`.
  const pendingToken = bridge.notePromptPending(sessionId)
  // Deliberately not awaited: the wait outlives the MCP call by design, and
  // its whole purpose is that the caller does not have to hold a transport
  // open for it. What IS awaited, later, is the bookkeeping — nothing is
  // counted as submitted, and no bootstrap is marked, until it really landed.
  void pending.then(async result => {
    // Whatever the outcome, THIS waiter is no longer pending. Token-scoped:
    // a waiter replaced by a newer one settles after the newer one armed.
    bridge.notePromptPendingSettled(sessionId, pendingToken)
    if (result.ok) {
      bridge.notePromptSubmitted(sessionId)
      if (input.markBootstrapOnLanding) {
        await bridge.markBootstrapPromptDelivered({
          parentSessionId: input.parentSessionId,
          sessionId,
        }).catch(() => undefined)
      }
      return
    }
    // A superseded wait lands here too (its message names the cause). That is
    // recorded deliberately rather than filtered: the journal is where "the
    // parent was told pending and that prompt never arrived" has to be
    // countable, whatever the reason.
    dependencies.appRunJournal?.recordIncident({
      kind: 'orchestration.prompt_delivery_failed',
      severity: 'error',
      reason: input.incidentReason,
      context: {
        sessionId,
        message: result.message,
        stage: result.stage,
        code: result.code,
        retrySafe: result.retrySafe,
        disposition: result.disposition,
        promptWritten: result.promptWritten,
        enterWritten: result.enterWritten,
      },
    })
  })
  return { supersededPendingPrompt }
}

// Cross-agent total budget for read_run_outputs / wait_agents (#373).
//
// WHY this lives in the tool handler and not in the renderer or bridge: the
// renderer produces outputs per agent and never sees the assembled multi-agent
// payload, and the bridge additionally merges in main-side closed-agent
// tombstones AFTER the renderer read. This is the last point before
// JSON.stringify hits the parent's context window, so it is the only place a
// total can be enforced honestly.
//
// Default sizing: per-agent reads default to 24_000 chars, so a 20-child run
// could still assemble ~480K chars of "individually bounded" output. 120_000
// chars (~30K tokens) keeps roughly five fully detailed agents while every
// other agent still reports status/lifecycle/counts plus a short excerpt —
// enough for a coordinator to decide which child to re-read with read_agent.
const DEFAULT_ORCHESTRATION_MAX_TOTAL_CHARS = 120_000

function boundOutputsToTotalChars(
  outputs: OrchestrationAgentOutput[],
  maxTotalChars: number | undefined,
  // Chars already committed to the same tool response OUTSIDE `outputs` —
  // wait_agents also returns an `agents` status array, and letting it ride
  // outside the budget meant maxTotalChars never actually bounded that tool's
  // payload (#510 review, both reviewers). Callers pass the JSON length of
  // those sibling fields so one budget governs the whole response.
  reservedChars = 0,
): { outputs: OrchestrationAgentOutput[]; truncated: boolean } {
  const cap = maxTotalChars === undefined
    ? DEFAULT_ORCHESTRATION_MAX_TOTAL_CHARS
    : Math.max(1_000, Math.min(2_000_000, Math.floor(maxTotalChars)))
  const budget = Math.max(0, cap - Math.max(0, reservedChars))
  // JSON.stringify length is the honest size metric here: it is exactly what
  // toolText emits into the model context, including keys and mirror fields.
  const fullSizes = outputs.map(output => JSON.stringify(output).length)
  const total = fullSizes.reduce((sum, size) => sum + size, 0)
  if (total <= budget) return { outputs, truncated: false }

  // Summary-first degradation: guarantee every agent's status/lifecycle/
  // counts and a short excerpt survive, THEN spend leftover budget restoring
  // full outputs in list order. The alternative — greedily keeping full
  // outputs until the budget dies — would silently drop entire agents at the
  // end of the list, and a coordinator that cannot see an agent at all will
  // misclassify it far worse than one that sees a truncated summary.
  let summaries = outputs.map(summarizeOrchestrationOutput)
  let summarySizes = summaries.map(summary => JSON.stringify(summary).length)
  let used = summarySizes.reduce((sum, size) => sum + size, 0)

  // Summaries alone can still exceed the budget (#510 review): the record's
  // ≤400-char excerpt mirrors times many agents, or a small explicit
  // maxTotalChars. Before this loop existed, `used` started over budget, the
  // upgrade pass below never fired, and the whole summary set was returned
  // anyway — maxTotalChars silently unenforced exactly when the caller most
  // needed it. Shrink every summary's text fields in progressively harsher
  // steps until the set fits. The last step is a hard floor, not zero:
  // latestAssistantText presence is a lifecycle signal ("this child produced
  // output") that must never be shrunk to empty/absent — same invariant as
  // mirrorExcerpt in the renderer. If even floor-shrunk summaries exceed the
  // budget, the residue is per-agent JSON skeleton (ids, timestamps, counts),
  // which we cannot cut without dropping agents entirely — the failure mode
  // this whole function exists to avoid. That residue is the "small
  // tolerance" callers must accept; it grows only with agent count.
  if (used > budget) {
    for (const excerptCap of SUMMARY_EXCERPT_SHRINK_STEPS) {
      summaries = summaries.map(summary => shrinkSummaryTextFields(summary, excerptCap))
      summarySizes = summaries.map(summary => JSON.stringify(summary).length)
      used = summarySizes.reduce((sum, size) => sum + size, 0)
      if (used <= budget) break
    }
  }

  const result: OrchestrationAgentOutput[] = [...summaries]
  for (let index = 0; index < outputs.length; index += 1) {
    const upgraded = used - summarySizes[index]! + fullSizes[index]!
    if (upgraded > budget) continue
    used = upgraded
    result[index] = outputs[index]!
  }
  return { outputs: result, truncated: true }
}

// Descending excerpt caps for the over-budget summary fallback. 400 is the
// renderer's MIRROR_EXCERPT_MAX_CHARS (the natural size of the mirrors), so
// the steps only need to cover below that. 48 is the floor: with the 24-char
// truncation-marker headroom it still leaves ~24 chars of real text — enough
// to be recognizably non-empty for the lifecycle-presence invariant, tiny
// enough that hundreds of agents stay near any sane budget.
const SUMMARY_EXCERPT_SHRINK_STEPS = [200, 100, 48] as const

// Marker matches boundText / truncateOrchestrationText / truncateItemText
// ("…\n[truncated]", 24-char headroom) — one truncation dialect everywhere.
// Duplicated here for the same reason as the bridge's copy: this module
// cannot import renderer code and there is no shared text-utils home yet;
// keep the four in sync if the marker ever changes.
function truncateSummaryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 24))}\n[truncated]`
}

function shrinkSummaryTextFields(
  summary: OrchestrationAgentOutput,
  maxChars: number,
): OrchestrationAgentOutput {
  // Only free-form text fields shrink; ids/counts/timestamps are the summary's
  // whole point. statusSummary/errorSummary are included because they carry
  // raw processError text, which is caller-uncontrolled and can be long.
  // Fields stay PRESENT when set — shortened, never dropped (lifecycle
  // invariant, see boundOutputsToTotalChars).
  const shrink = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : truncateSummaryText(value, maxChars)
  return {
    ...summary,
    agent: {
      ...summary.agent,
      ...(summary.agent.statusSummary !== undefined
        ? { statusSummary: shrink(summary.agent.statusSummary) }
        : {}),
      ...(summary.agent.errorSummary !== undefined
        ? { errorSummary: shrink(summary.agent.errorSummary) }
        : {}),
      ...(summary.agent.latestAssistantText !== undefined
        ? { latestAssistantText: shrink(summary.agent.latestAssistantText) }
        : {}),
      ...(summary.agent.finalAssistantText !== undefined
        ? { finalAssistantText: shrink(summary.agent.finalAssistantText) }
        : {}),
    },
    ...(summary.latestAssistantText !== undefined
      ? { latestAssistantText: shrink(summary.latestAssistantText) }
      : {}),
    ...(summary.finalAssistantText !== undefined
      ? { finalAssistantText: shrink(summary.finalAssistantText) }
      : {}),
  }
}

function summarizeOrchestrationOutput(output: OrchestrationAgentOutput): OrchestrationAgentOutput {
  // The agent record already carries lifecycleState, statusSummary, counts and
  // ≤400-char excerpt mirrors — exactly the "summary" a coordinator needs.
  // Message bodies are what blow the budget, so they are dropped; messageCount
  // on the record still says how much exists. latestAssistantText keeps a
  // short excerpt rather than disappearing: callers pattern-match on its
  // presence to mean "the child produced output" (same invariant as the
  // renderer lifecycle hazard — shorten, never drop).
  const excerpt = output.agent.latestAssistantText ?? output.finalAssistantText
  const originalChars = output.totalChars
    ?? output.messages.reduce((sum, message) => sum + (message.totalChars ?? message.text.length), 0)
  return {
    agent: output.agent,
    messages: [],
    ...(output.latestAssistantText
      ? {
          latestAssistantText: excerpt ?? output.latestAssistantText,
          finalAssistantText: excerpt ?? output.latestAssistantText,
        }
      : {}),
    truncated: true,
    ...(originalChars > 0 ? { totalChars: originalChars } : {}),
  }
}

function isOrchestrationAgentActive(state: string | undefined): boolean {
  return (
    state === undefined ||
    state === 'created' ||
    state === 'prompt_sent' ||
    state === 'running' ||
    state === 'waiting'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Prompt delivery moved to the provider registry (#394 phase 2c):
// manager.deliverPromptToAgent → getMainProvider(kind).deliverPrompt →
// providers/<kind>/runtime/promptDelivery.ts. The per-provider WHY
// blocks (Codex readiness-before-paste + atomic paste+Enter; Claude
// paste/image absorption → Enter → durable acceptance) moved with the code.
// The inline `if codex … if claude …` that lived here let a third
// provider fall through to a protocol-free paste (#394 §4.2).

function toolText(value: unknown): {
  content: Array<{ type: 'text'; text: string }>
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value),
      },
    ],
  }
}
