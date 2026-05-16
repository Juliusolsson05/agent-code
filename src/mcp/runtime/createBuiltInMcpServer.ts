import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { OrchestrationAgentKind } from '@mcp/shared/orchestrationTypes.js'
import type { BuiltInMcpDependencies } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { BuiltInMcpDomain, McpSessionScope } from '@mcp/shared/types.js'

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

  return server
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
        builtInMcpDomains: z.array(z.enum(['ping', 'orchestration'])).optional(),
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
        builtInMcpDomains: args.builtInMcpDomains as BuiltInMcpDomain[] | undefined,
      })

      if (args.prompt && args.prompt.trim().length > 0) {
        await submitPrompt(manager, agent.sessionId, args.prompt)
      }

      return toolText({
        ok: true,
        agent,
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
      if (!manager) {
        return toolText({
          ok: false,
          error: 'session_manager_unavailable',
          message: 'Agent Code session manager is not available.',
        })
      }
      await submitPrompt(manager, args.sessionId, args.prompt)
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
}

async function submitPrompt(
  manager: NonNullable<BuiltInMcpDependencies['sessionManager']>,
  sessionId: string,
  prompt: string,
): Promise<void> {
  // WHY the MCP tool writes bracketed paste instead of plain text:
  //
  // Orchestration prompts are often long, markdown-heavy bootstrap prompts.
  // Sending them as keystrokes would let provider TUIs interpret newlines or
  // escape sequences as interactive input. Bracketed paste is the same
  // terminal-level contract the composer uses for large prompts. For Claude we
  // also wait for the paste placeholder when available, matching the
  // renderer's paste-submit state machine closely enough that MCP-created
  // agents do not need a hidden composer just to receive their first task.
  manager.write(sessionId, `\x1b[200~${prompt}\x1b[201~`)
  const pasteState = await manager.awaitClaudePastePlaceholder(sessionId, {
    timeoutMs: 2000,
    pollIntervalMs: 50,
  })
  if (pasteState.kind === 'appeared' || pasteState.kind === 'timeout') {
    manager.write(sessionId, '\r')
    return
  }
  manager.write(sessionId, '\r')
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
