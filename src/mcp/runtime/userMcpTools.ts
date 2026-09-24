import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { UserMcpService } from '@main/userMcp/service.js'
import type { McpSessionScope } from '@mcp/shared/types.js'
import type { UserMcpMutationResult, UserMcpServerView, UserMcpSnapshot } from '@shared/userMcp/types.js'
import { providerSupportForEntry } from '@shared/userMcp/validate.js'

/**
 * The `mcp_servers` built-in domain (#1143): lets an agent manage Agent
 * Code's OWN MCP server configuration — "install the Beeper MCP server for me".
 *
 * WHY tools over the service instead of a skill that points the agent at
 * mcp-servers.json: main loads that document once and serializes every write
 * through one queue, so a file edited behind its back is either overwritten by
 * the next Settings change or ignored until restart. Secrets are not in the
 * file at all (they are safeStorage blobs an agent cannot produce). Going
 * through UserMcpService gives the agent the exact validation, secret handling
 * and broadcast that the Settings UI gets, and nothing else.
 *
 * WHY there is no tool that reads a secret back: an agent that can set a token
 * because the user just handed it one has no reason to ever read one, and a
 * read tool would turn any prompt injection into credential exfiltration.
 */
/** At most this many servers per mcp_servers_add call. The 64 KB config cap
 * alone admits thousands of tiny entries, each a queued save, snapshot and
 * broadcast in main (review round 2). */
const MAX_SERVERS_PER_ADD = 20

export type UserMcpToolDependencies = {
  userMcpService?: Pick<UserMcpService, 'snapshot' | 'importConfig' | 'save' | 'delete' | 'setEnabled' | 'setProvider' | 'setSecret'>
  /** Tells every window that an agent changed the MCP configuration. */
  onUserMcpChangedByAgent?: (event: { sessionId: string; message: string }) => void
}

export const MCP_SERVERS_INSTRUCTIONS = `MCP Servers lets you manage the user's own MCP servers in Agent Code (the servers Agent Code attaches to new Claude and Codex agents). Only add, change or remove servers when the user's current request asks for it; never add a server on your own initiative, and prefer the exact config the server's official documentation publishes. Add servers with mcp_servers_add using that config (a {"mcpServers": {...}} block, a VS Code {"servers": ...} block, or one entry). Every env and header value in it becomes an encrypted secret automatically; README placeholders such as YOUR_TOKEN_HERE stay unset. A server you add, or point at a different URL, command, arguments or environment, is saved switched OFF and waits for the user's review: tell the user to review it and turn it on in Settings → MCP. You cannot turn a server on. Set a secret with mcp_servers_set_secret only when the user has given you the value in this conversation; otherwise tell the user to set it in Settings → MCP. Never repeat a secret value back. Changes apply to new agents and to existing agents when they reload — including you: you will not get a server's tools until the user reloads you. OAuth servers sign in through the CLIs (codex mcp login, or /mcp in Claude); say so instead of looking for a token. Report exactly what you changed.`

export function registerUserMcpTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: UserMcpToolDependencies,
): void {
  const service = () => {
    if (!dependencies.userMcpService) throw new Error('MCP server management is unavailable.')
    return dependencies.userMcpService
  }
  const failure = (error: unknown) => ({
    ...toolText({ ok: false, message: error instanceof Error ? error.message : 'MCP server change failed.' }),
    isError: true,
  })
  const changed = (message: string) => dependencies.onUserMcpChangedByAgent?.({ sessionId: scope.sessionId, message })
  const mutation = (result: UserMcpMutationResult) => result.ok
    ? toolText({ ok: true, servers: result.snapshot.servers.map(describeServer) })
    : { ...toolText({ ok: false, message: result.error, problems: result.problems ?? [] }), isError: true }
  const nameOf = async (id: string) => (await service().snapshot()).servers.find(candidate => candidate.id === id)?.name ?? id

  server.registerTool('mcp_servers_list', {
    title: 'List MCP servers',
    description: 'List the user\'s MCP servers managed by Agent Code (ids, transport, which providers new agents get them on, whether secrets are set, problems) and the servers each CLI loads from its own config (read-only). Secret values are never returned.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return toolText({ ok: true, ...describeSnapshot(await service().snapshot()) })
    } catch (error) {
      return failure(error)
    }
  })

  server.registerTool('mcp_servers_add', {
    title: 'Add MCP servers',
    description: 'Add one or more MCP servers (at most 20) from a config snippet as published by the server\'s documentation: {"mcpServers": {...}}, a VS Code {"servers": ...} block, or a single entry (then pass name). Env and header values are stored as encrypted secrets automatically. New servers are saved switched off until the user reviews and turns them on in Settings → MCP. Returns the new server ids and any secrets still to set.',
    inputSchema: {
      config: z.string().min(2).max(64 * 1024).describe('The JSON config snippet.'),
      name: z.string().min(1).max(64).optional().describe('Server name, used only when config is a single bare entry.'),
      claude: z.boolean().optional().describe('Attach to new Claude agents. Defaults to true when supported.'),
      codex: z.boolean().optional().describe('Attach to new Codex agents. Defaults to true when supported (not for SSE).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ config, name, claude, codex }) => {
    try {
      const imported = service().importConfig(config, name)
      if (!imported.ok) return { ...toolText({ ok: false, message: imported.error }), isError: true }
      if (imported.candidates.length > MAX_SERVERS_PER_ADD) {
        return { ...toolText({ ok: false, message: `Add at most ${MAX_SERVERS_PER_ADD} servers per call.` }), isError: true }
      }
      const added: unknown[] = []
      const addedNames: string[] = []
      for (const candidate of imported.candidates) {
        const support = providerSupportForEntry(candidate.entry)
        const result = await service().save({
          name: candidate.name,
          // Stored off regardless (actor 'agent'); see UserMcpServer.pendingReview.
          enabled: false,
          providers: {
            claude: support.claude.ok && (claude ?? true),
            codex: support.codex.ok && (codex ?? true),
          },
          entry: candidate.entry,
          inputs: candidate.inputs,
          secrets: candidate.pendingSecrets,
        }, 'agent')
        if (!result.ok) {
          if (addedNames.length > 0) changed(`An agent added MCP server${addedNames.length > 1 ? 's' : ''} ${addedNames.join(', ')} (off until you review ${addedNames.length > 1 ? 'them' : 'it'})`)
          return { ...toolText({ ok: false, message: `${candidate.name}: ${result.error}`, added, problems: result.problems ?? [] }), isError: true }
        }
        const view = result.snapshot.servers.find(serverView => serverView.id === result.id)
        added.push(view ? describeServer(view) : { name: candidate.name })
        addedNames.push(candidate.name)
      }
      // One notice per call, not per server: the toast slot is single, so a
      // per-server notice left only the last of a burst visible (review round 2).
      changed(`An agent added MCP server${addedNames.length > 1 ? 's' : ''} ${addedNames.join(', ')} (off until you review ${addedNames.length > 1 ? 'them' : 'it'})`)
      return toolText({
        ok: true,
        added,
        note: 'Saved switched off. Ask the user to review and turn it on in Settings → MCP; it then applies to new agents and to existing agents after they reload.',
      })
    } catch (error) {
      return failure(error)
    }
  })

  server.registerTool('mcp_servers_update', {
    title: 'Update an MCP server',
    description: 'Change one server: its name, its config entry (the full entry object, same shape as mcp_servers_add accepts; keep ${input:…} references for secrets), which providers new agents get it on, or turn it OFF. Changing the entry\'s URL, command, arguments or environment forgets its stored secrets and switches it off until the user reviews it. You cannot turn a server on.',
    inputSchema: {
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(64).optional(),
      entry: z.record(z.string(), z.unknown()).optional(),
      enabled: z.literal(false).optional().describe('Pass false to switch the server off. Only the user can switch it on.'),
      claude: z.boolean().optional(),
      codex: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, name, entry, enabled, claude, codex }) => {
    try {
      const current = (await service().snapshot()).servers.find(candidate => candidate.id === id)
      if (!current) return { ...toolText({ ok: false, message: `No MCP server with id ${id}.` }), isError: true }
      const nextEntry = (entry ?? current.entry) as typeof current.entry
      // Secret definitions follow the entry, exactly as in the Settings
      // editor: references keep their existing definition, new ones get one.
      const referenced = [...new Set([...JSON.stringify(nextEntry).matchAll(/\$\{input:([A-Za-z0-9_-]{1,64})\}/g)].map(match => match[1]!))]
      const result = await service().save({
        id,
        name: name ?? current.name,
        enabled: enabled ?? current.enabled,
        providers: { claude: claude ?? current.providers.claude, codex: codex ?? current.providers.codex },
        entry: nextEntry,
        inputs: referenced.map(inputId => current.inputs.find(input => input.id === inputId) ?? { id: inputId, description: 'Secret' }),
      }, 'agent')
      if (result.ok) {
        changed(result.pendingReview
          ? `An agent changed MCP server ${name ?? current.name} (off until you review it)`
          : `An agent changed MCP server ${name ?? current.name}`)
      }
      return mutation(result)
    } catch (error) {
      return failure(error)
    }
  })

  server.registerTool('mcp_servers_remove', {
    title: 'Remove an MCP server',
    description: 'Delete one of the user\'s MCP servers and its stored secrets. Only when the user\'s current request asks to remove that server.',
    inputSchema: { id: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    try {
      const name = await nameOf(id)
      const result = await service().delete(id)
      if (result.ok) changed(`An agent removed MCP server ${name}`)
      return mutation(result)
    } catch (error) {
      return failure(error)
    }
  })

  server.registerTool('mcp_servers_set_secret', {
    title: 'Set an MCP server secret',
    description: 'Store one secret (a ${input:id} the server config references) encrypted. Only use a value the user gave you in this conversation; never invent one. The value is never returned by any tool.',
    inputSchema: {
      id: z.string().min(1).max(64),
      inputId: z.string().min(1).max(64),
      value: z.string().min(1).max(64 * 1024),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, inputId, value }) => {
    try {
      const name = await nameOf(id)
      const result = await service().setSecret(id, inputId, value)
      if (result.ok) changed(`An agent set a secret for MCP server ${name}`)
      return mutation(result)
    } catch (error) {
      return failure(error)
    }
  })
}

/** What an agent sees of a server: everything except secret values, which
 * the view type does not carry in the first place. */
function describeServer(server: UserMcpServerView) {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    ...(server.pendingReview ? { waitingForUserReview: true } : {}),
    providers: server.providers,
    transport: server.transport,
    // The redacted one-line summary, never the raw entry (review round 2):
    // args and URLs have no secret channel and often carry credentials, and
    // everything this returns lands in the transcript and at the provider.
    // An update passes the complete entry it wants anyway.
    summary: server.summary,
    secretReferences: server.inputs.map(input => input.id),
    secrets: Object.fromEntries(Object.entries(server.secrets).map(([id, state]) => [id, state.set ? 'set' : 'not set'])),
    problems: server.problems.map(problem => problem.message),
    unsupported: Object.fromEntries(Object.entries(server.support).flatMap(([provider, support]) =>
      support.ok ? [] : [[provider, support.reason]])),
  }
}

function describeSnapshot(snapshot: UserMcpSnapshot) {
  return {
    servers: snapshot.servers.map(describeServer),
    loadedByCliDirectly: snapshot.native.map(native => ({
      provider: native.provider,
      name: native.name,
      source: native.source,
      summary: native.summary,
    })),
    ...(snapshot.claudeManagedPolicy ? { note: 'An enterprise Claude MCP policy is active: user servers are not attached to Claude agents.' } : {}),
  }
}

function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}
