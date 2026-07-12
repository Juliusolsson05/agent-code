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
import {
  AGENT_PROVIDER_KINDS,
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  type AgentProviderKind,
} from '@shared/types/providerKind.js'

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
        [
          'Creates a distinct Agent Code orchestration child agent in Dispatch, optionally bootstrapped with an initial prompt.',
          'Use this only when the user explicitly asks for delegated, parallel, or orchestrated agent work.',
          'The child currently starts from a clean provider conversation; include any necessary parent context directly in the prompt.',
        ].join(' '),
      inputSchema: {
        kind: z.enum(AGENT_PROVIDER_KINDS).default(DEFAULT_PROVIDER),
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
        if (!delivery.ok) {
          let cleanupAttempted = false
          let agentClosed = false
          let cleanupError: string | undefined
          // WHY cleanup only a retry-safe rejection: after any prompt/Enter
          // bytes were written, a timeout means acceptance is UNKNOWN, not
          // absent. Closing that child can kill a correctly submitted turn and
          // encourages callers to create a duplicate replacement agent.
          if (delivery.retrySafe) {
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
            // WHY omit the live agent object on bootstrap failure:
            // `create_agent` is a two-step operation. By this point the
            // renderer has already created a real provider session with PTY,
            // proxy, JSONL watchers, and scoped MCP registration, but the
            // caller receives an error and usually abandons the handle. Returning
            // the full agent here made that half-created child look usable while
            // leaving cleanup to memory and luck. The failure result now reports
            // the session id plus cleanup outcome, and the child is best-effort
            // closed before the error crosses the MCP boundary only when no
            // bytes were written and the result explicitly says retry is safe.
            sessionId: agent.sessionId,
            cleanupAttempted,
            agentClosed,
            cleanupError,
            promptSubmitted: false,
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

  server.registerTool(
    'orchestration_send_prompt',
    {
      title: 'Send Prompt To Orchestration Agent',
      description:
        'Sends a follow-up prompt to an existing orchestration-created Agent Code session.',
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
      const delivery = await manager.deliverPromptToAgent(args.sessionId, prompt)
      if (!delivery.ok) {
        dependencies.appRunJournal?.recordIncident({
          kind: 'orchestration.prompt_delivery_failed',
          severity: 'error',
          reason: 'send_prompt',
          context: { sessionId: args.sessionId, message: delivery.message },
        })
        return toolText({
          ok: false,
          error: 'prompt_delivery_failed',
          message: delivery.message,
          retrySafe: delivery.retrySafe,
          sessionId: args.sessionId,
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
          })
        }
      }
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
        'Waits for all matching orchestration-created child agents to leave active states, then returns their statuses and latest outputs. Outputs are byte-capped per message/agent and share a cross-agent total budget; over-budget agents degrade to status summaries with short excerpts and truncated=true. To recover a truncated agent, re-read it with orchestration_read_agent and explicit larger caps, or use agent_transcript_read_file on its transcript.',
      inputSchema: {
        runId: z.string().optional(),
        sessionIds: z.array(z.string()).optional(),
        timeoutMs: z.number().int().min(1000).max(600000).default(30000),
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
        maxCharsPerMessage: args.maxCharsPerMessage,
        maxCharsPerAgent: args.maxCharsPerAgent,
      }).then(outputs => outputs.filter(output => agentIds.has(output.agent.sessionId)))
      // The `agents` status array below is part of the same tool response, so
      // its JSON size is charged against maxTotalChars as reservedChars —
      // otherwise wait_agents' real payload would exceed the budget by
      // exactly the part the budget was never told about (#510 review).
      // Status records carry no message bodies, so this reservation is small
      // and proportional to agent count, not output size.
      const bounded = boundOutputsToTotalChars(
        outputs,
        args.maxTotalChars,
        JSON.stringify(agents).length,
      )
      return toolText({
        ok: true,
        done: !agents.some(agent => isOrchestrationAgentActive(agent.lifecycleState)),
        agents,
        outputs: bounded.outputs,
        ...(bounded.truncated ? { truncated: true } : {}),
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
// paste → placeholder confirm → separate Enter) moved with the code.
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
