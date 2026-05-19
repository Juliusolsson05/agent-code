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
} from '@mcp/shared/orchestrationTypes.js'
import { buildOrchestrationBootstrapPrompt } from '@mcp/shared/orchestrationPrompt.js'
import type { BuiltInMcpDependencies } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { BuiltInMcpDomain, McpSessionScope } from '@mcp/shared/types.js'
import type { SessionKind } from '@main/sessionManager.js'

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
    },
  )

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

  if (scope.domains.includes('ai_workspace')) {
    registerAiWorkspaceTools(server, scope, dependencies)
  }

  if (scope.domains.includes('agent_transcripts')) {
    registerAgentTranscriptTools(server)
  }

  return server
}

function registerAgentTranscriptTools(server: McpServer): void {
  const providerSchema = z.enum(['claude', 'codex', 'auto']).default('auto')
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

  // WHY these tools take an explicit filesystem path instead of trying to
  // discover "the right" transcript:
  //
  // The product use case is controlled consumption of another agent's work
  // product, not a global transcript browser. The UI, orchestration metadata,
  // or a handoff prompt already knows which Claude/Codex JSONL file matters.
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
        'Reads one Claude or Codex transcript JSONL file by path and returns a normalized, filtered, bounded projection of user-visible agent context.',
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
        'Searches one Claude or Codex transcript JSONL file by path and returns bounded normalized matches with optional surrounding context.',
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
        'Inspects one Claude or Codex transcript JSONL file by path and returns provider, timestamp, and item-count metadata without dumping content.',
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
  server.registerTool(
    'orchestration_create_agent',
    {
      title: 'Create Orchestration Agent',
      description:
        'Creates a distinct Agent Code orchestration child agent in Dispatch, optionally bootstrapped with an initial prompt.',
      inputSchema: {
        kind: z.enum(['claude', 'codex']).default('claude'),
        prompt: z.string().optional(),
        cwd: z.string().optional(),
        title: z.string().optional(),
        role: z.string().optional(),
        runId: z.string().optional(),
        inheritParentContext: z.boolean().default(true).optional(),
        builtInMcpDomains: z.array(z.enum(['ping', 'orchestration', 'ai_workspace', 'agent_transcripts'])).optional(),
      },
    },
    async args => {
      const bridge = dependencies.orchestrationBridge
      const manager = dependencies.sessionManager
      if (!bridge || !manager) {
        return toolText({
          ok: false,
          error: 'orchestration_unavailable',
          message: 'Agent Code orchestration services are not available.',
        })
      }

      const agent = await bridge.createAgent({
        parentSessionId: scope.sessionId,
        kind: args.kind as OrchestrationAgentKind,
        cwd: args.cwd,
        title: args.title,
        role: args.role,
        runId: args.runId,
        inheritParentContext: args.inheritParentContext,
        builtInMcpDomains: args.builtInMcpDomains as BuiltInMcpDomain[] | undefined,
      })

      if (args.prompt && args.prompt.trim().length > 0) {
        const prompt = buildOrchestrationBootstrapPrompt({
          task: args.prompt,
          inheritedParentContext: agent.inheritedParentContext === true,
        })
        const delivery = await submitPrompt(manager, agent.sessionId, agent.kind, prompt)
        if (!delivery.ok) {
          return toolText({
            ok: false,
            error: 'prompt_delivery_failed',
            message: delivery.message,
            agent,
            promptSubmitted: false,
          })
        }
        bridge.notePromptSubmitted(agent.sessionId)
      }

      return toolText({
        ok: true,
        agent: (await bridge.listAgents({ parentSessionId: scope.sessionId, runId: args.runId }).catch(() => [agent]))
          .find(item => item.sessionId === agent.sessionId) ?? agent,
        promptSubmitted: Boolean(args.prompt && args.prompt.trim().length > 0),
      })
    },
  )

  server.registerTool(
    'orchestration_send_prompt',
    {
      title: 'Send Prompt To Orchestration Agent',
      description:
        'Sends a follow-up prompt to an existing orchestration-created Agent Code session.',
      inputSchema: {
        sessionId: z.string(),
        prompt: z.string(),
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
      const kind = manager.getSessionKind(args.sessionId)
      if (kind !== 'claude' && kind !== 'codex') {
        return toolText({
          ok: false,
          error: 'not_agent_session',
          message: `Cannot send orchestration prompt to non-agent session ${args.sessionId}`,
          sessionId: args.sessionId,
        })
      }
      const shouldWrap = bridge.promptSubmissionCount(args.sessionId) === 0
      const prompt = shouldWrap
        ? buildOrchestrationBootstrapPrompt({
            task: args.prompt,
            inheritedParentContext: output.agent.inheritedParentContext === true,
          })
        : args.prompt
      const delivery = await submitPrompt(manager, args.sessionId, kind, prompt)
      if (!delivery.ok) {
        return toolText({
          ok: false,
          error: 'prompt_delivery_failed',
          message: delivery.message,
          sessionId: args.sessionId,
        })
      }
      bridge.notePromptSubmitted(args.sessionId)
      return toolText({ ok: true, sessionId: args.sessionId })
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
        'Reads clean user-visible output from one orchestration-created child agent. Returns visible messages and latest/final assistant text without provider-internal event noise.',
      inputSchema: {
        sessionId: z.string(),
        maxMessages: z.number().int().min(1).max(100).optional(),
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
        'Reads clean user-visible outputs from every orchestration child agent in this parent session, optionally filtered by run id.',
      inputSchema: {
        runId: z.string().optional(),
        maxMessagesPerAgent: z.number().int().min(1).max(100).optional(),
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
      })
      return toolText({ ok: true, outputs })
    },
  )

  server.registerTool(
    'orchestration_wait_agents',
    {
      title: 'Wait For Orchestration Agents',
      description:
        'Waits for all matching orchestration-created child agents to leave active states, then returns their statuses and latest outputs.',
      inputSchema: {
        runId: z.string().optional(),
        sessionIds: z.array(z.string()).optional(),
        timeoutMs: z.number().int().min(1000).max(600000).default(30000),
        pollIntervalMs: z.number().int().min(250).max(10000).default(1000),
        maxMessagesPerAgent: z.number().int().min(1).max(100).optional(),
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
      const deadline = Date.now() + args.timeoutMs
      let agents = await bridge.listAgents({ parentSessionId: scope.sessionId, runId: args.runId })
      if (args.sessionIds && args.sessionIds.length > 0) {
        const wanted = new Set(args.sessionIds)
        agents = agents.filter(agent => wanted.has(agent.sessionId))
      }
      while (Date.now() < deadline && agents.some(agent => isOrchestrationAgentActive(agent.lifecycleState))) {
        await sleep(args.pollIntervalMs)
        agents = await bridge.listAgents({ parentSessionId: scope.sessionId, runId: args.runId })
        if (args.sessionIds && args.sessionIds.length > 0) {
          const wanted = new Set(args.sessionIds)
          agents = agents.filter(agent => wanted.has(agent.sessionId))
        }
      }
      const agentIds = new Set(agents.map(agent => agent.sessionId))
      const outputs = await bridge.readRunOutputs({
        parentSessionId: scope.sessionId,
        runId: args.runId,
        maxMessagesPerAgent: args.maxMessagesPerAgent,
      }).then(outputs => outputs.filter(output => agentIds.has(output.agent.sessionId)))
      return toolText({
        ok: true,
        done: !agents.some(agent => isOrchestrationAgentActive(agent.lifecycleState)),
        agents,
        outputs,
      })
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

async function submitPrompt(
  manager: NonNullable<BuiltInMcpDependencies['sessionManager']>,
  sessionId: string,
  kind: Extract<SessionKind, 'claude' | 'codex'>,
  prompt: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // WHY the MCP tool writes bracketed paste instead of plain text:
  //
  // Orchestration prompts are often long, markdown-heavy bootstrap prompts.
  // Sending them as keystrokes would let provider TUIs interpret newlines or
  // escape sequences as interactive input. Bracketed paste is the same
  // terminal-level contract the composer uses for large prompts.
  //
  // WHY Codex waits BEFORE the paste while Claude waits AFTER:
  //
  // Claude's known race is paste-commit ordering: the composer is present, but
  // Enter can arrive before the paste accumulator has replaced the payload
  // with `[Pasted text #N]`. Codex's issue #211 race is earlier: `spawn()`
  // has resolved and the PTY exists, but the TUI may still be on startup/trust
  // chrome. Bytes written in that window disappear and no rollout file is
  // created. The parent agent must not see `promptSubmitted: true` for that
  // case, so this helper treats provider readiness and write success as the
  // delivery boundary.
  if (kind === 'codex') {
    const ready = await manager.awaitCodexReadyForPrompt(sessionId, {
      timeoutMs: 15_000,
      pollIntervalMs: 50,
    })
    if (ready.kind !== 'ready') {
      return {
        ok: false,
        message: `Codex session ${sessionId} was not ready for prompt delivery (${ready.kind})`,
      }
    }
  }

  if (!manager.write(sessionId, `\x1b[200~${prompt}\x1b[201~`)) {
    return {
      ok: false,
      message: `Could not write orchestration prompt to session ${sessionId}`,
    }
  }

  if (kind === 'claude') {
    await manager.awaitClaudePastePlaceholder(sessionId, {
      timeoutMs: 2000,
      pollIntervalMs: 50,
    })
  }

  if (!manager.write(sessionId, '\r')) {
    return {
      ok: false,
      message: `Could not submit orchestration prompt to session ${sessionId}`,
    }
  }
  return { ok: true }
}

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
