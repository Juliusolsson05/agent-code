import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { McpSessionScope } from '@mcp/shared/types.js'

/**
 * The `hermes` built-in domain (#1512): a coding agent reads and messages the
 * owner's Hermes agent (Nous Research, on their VPS) through the connection
 * Agent Code already holds.
 *
 * WHY its own domain, off by default and parent-held-only: a send makes the
 * owner's personal agent ACT (it has terminal access on their server and
 * their connected accounts), so it is something the owner switches on per
 * provider in Settings → MCP, and an orchestrator may pass it to a child only
 * when it holds it itself. It is not confirmation-gated like root_management:
 * the blast radius is a conversation with the owner's own agent, visible in
 * Hermes like any other.
 */
export type HermesToolDependencies = {
  /** Main's HermesAgentBridge. Injected because src/mcp must not import main;
   *  missing means composition did not wire it, and the tools say so. */
  hermesAgentBridge?: HermesAgentBridgePort
  /** A short human name for the calling agent (its Goal, when it set one),
   *  for titling its own Hermes conversation. Main does not hold pane titles
   *  (they are renderer state), and the Goal is the sentence the owner reads
   *  to know what an agent is for. */
  sessionTitle?: (scope: McpSessionScope) => Promise<string | null>
}

/** The slice of HermesAgentBridge the tools call (main/hermes/agentBridge.ts). */
export type HermesAgentBridgePort = {
  conversations(callerSessionId: string, options: { connection?: string }): Promise<unknown>
  read(callerSessionId: string, options: { connection?: string; conversation?: string; limit?: number }): Promise<unknown>
  send(callerSessionId: string, callerTitle: string, options: { text: string; connection?: string; conversation?: string; wait?: boolean; timeoutSeconds?: number }): Promise<unknown>
}

export const HERMES_INSTRUCTIONS = [
  'Hermes (hermes_conversations, hermes_read, hermes_send): the user\'s personal Hermes agent on their own server, which can act with their accounts and a terminal there.',
  'By default your messages go to a Hermes conversation of your own, not the user\'s Telegram thread; pass conversation "telegram" only when the user asked you to write there, or an id from hermes_conversations to continue a specific conversation.',
  'Send Hermes only what the user\'s request calls for. hermes_send waits for the reply by default and returns it; "still_running" means read it later with hermes_read, "awaiting_approval" means Hermes is asking the user to approve something (tell the user; you cannot answer it), "held" means the user\'s phone conversation is busy and nothing was sent.',
  'If a send reports it may or may not have reached Hermes, read the conversation before sending again, or Hermes may do the work twice.',
].join(' ')

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...(value as object) }) }] })
const fail = (message: string, code?: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...(code ? { code } : {}), message }) }], isError: true })

/**
 * Curated failures only: HermesBridgeError carries a message written for the
 * agent. Anything else (a socket error, a server body) can carry server
 * detail or URLs, so it becomes one generic sentence and stays in main's log.
 */
function failure(error: unknown) {
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'HermesBridgeError') {
    const { code, message } = error as { code?: string; message: string }
    return fail(message, code)
  }
  console.warn('[hermes-mcp] tool failed:', error)
  return fail('The Hermes request failed.')
}

const connection = z.string().min(1).max(200).optional().describe('Connection name or id (only needed when several Hermes servers are signed in).')
const conversation = z.string().min(1).max(200).optional().describe('"own" (default: your own Hermes conversation), "telegram" (the user\'s Telegram thread), or a conversation id from hermes_conversations.')

export function registerHermesTools(server: McpServer, scope: McpSessionScope, dependencies: HermesToolDependencies): void {
  const bridge = dependencies.hermesAgentBridge
  const unavailable = () => fail('Hermes is unavailable in this build.')

  server.registerTool('hermes_conversations', {
    title: 'List Hermes conversations',
    description: 'List the signed-in Hermes connection, whether it has a Telegram thread, your own Hermes conversation id (if you have sent before), and the most recent conversations with their ids and titles.',
    inputSchema: { connection },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    if (!bridge) return unavailable()
    try {
      return ok(await bridge.conversations(scope.sessionId, { connection: input.connection }))
    } catch (error) {
      return failure(error)
    }
  })

  server.registerTool('hermes_read', {
    title: 'Read a Hermes conversation',
    description: 'Read the last messages of a Hermes conversation as text: the user\'s and your messages, Hermes\' replies, and one line per tool Hermes ran. Defaults to your own conversation.',
    inputSchema: {
      connection,
      conversation,
      limit: z.number().int().min(1).max(100).optional().describe('How many of the latest messages (default 20).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    if (!bridge) return unavailable()
    try {
      return ok(await bridge.read(scope.sessionId, { connection: input.connection, conversation: input.conversation, limit: input.limit }))
    } catch (error) {
      return failure(error)
    }
  })

  server.registerTool('hermes_send', {
    title: 'Message Hermes',
    description: 'Send the user\'s Hermes agent a message and, by default, wait for its reply. Never interrupts a turn Hermes is running (the message queues behind it). Returns status replied (with reply and the tools Hermes ran), accepted (wait false), still_running, awaiting_approval, or held.',
    inputSchema: {
      text: z.string().min(1).max(20_000).describe('The message to Hermes.'),
      connection,
      conversation,
      wait: z.boolean().optional().describe('Wait for the reply (default true).'),
      timeoutSeconds: z.number().int().min(1).max(900).optional().describe('How long to wait for the reply (default 300, max 900).'),
    },
    // Not read-only and open-world: Hermes acts on the user's server and accounts.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    if (!bridge) return unavailable()
    const named = await dependencies.sessionTitle?.(scope).catch(() => null)
    const title = named?.trim() || `agent ${scope.sessionId.slice(0, 8)}`
    try {
      return ok(await bridge.send(scope.sessionId, title, {
        text: input.text,
        connection: input.connection,
        conversation: input.conversation,
        wait: input.wait,
        timeoutSeconds: input.timeoutSeconds,
      }))
    } catch (error) {
      return failure(error)
    }
  })
}
