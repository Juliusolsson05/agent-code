import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ControlError, defineCapability, externalConnectionStatusSchema, type ExternalConnectionStatus } from '@control-sdk'

export type ExternalClientIntegration = {
  client: 'codex' | 'claude'
  configPath: string
  skillPath: string
  reconcile(connection: { url: string; token: string } | null): Promise<void>
}

// Which external clients receive the connection. WHY a missing `clients`
// means BOTH: files written before #1539 had no such field and the whole point
// of that change is that Claude Code users get set up too. Someone who wants
// only one client unticks the other in Settings, and that removes our entry.
const clientsSchema = z.object({ codex: z.boolean(), claude: z.boolean() }).strict()
type SelectedClients = z.infer<typeof clientsSchema>
const allClients: SelectedClients = { codex: true, claude: true }
const persistedSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/),
  clients: clientsSchema.default(allClients) }).strict()

// Main owns this preference for the whole app, not whichever renderer happened
// to hydrate last. Two settings windows cannot start competing listeners or
// rotate each other's key through independent localStorage copies. The secret
// never appears in SDK results or call history: copying is a local clipboard
// action that reports only success, while disk state is private to this user.
export function createExternalControlSettings(directory: string, port: {
  start(port: number, token: string): Promise<number>
  stop(): Promise<void>
  copy(text: string): void
  integrations?: ExternalClientIntegration[]
}) {
  const integrations = port.integrations ?? []
  // Last reconcile's failure per client; absent = that client is in sync.
  const clientErrors = new Map<ExternalClientIntegration['client'], string>()
  let enabled = false
  let configuredPort = 47653
  let clients: SelectedClients = { ...allClients }
  let token: string | undefined
  let runningPort: number | null = null
  let error: string | null = null
  let serial: Promise<unknown> = Promise.resolve()
  const path = join(directory, 'external-control.json')
  const status = (): ExternalConnectionStatus => ({ enabled, running: runningPort !== null, port: configuredPort,
    url: runningPort === null ? null : `http://127.0.0.1:${runningPort}/mcp`, serverName: 'agent-code-control', error,
    codex: clientStatus('codex'), claude: clientStatus('claude') })
  const clientStatus = (client: ExternalClientIntegration['client']) => {
    const integration = integrations.find(candidate => candidate.client === client)
    if (!integration) return null
    const clientError = clientErrors.get(client) ?? null
    return { configPath: integration.configPath, skillPath: integration.skillPath, error: clientError, selected: clients[client],
      managed: clients[client] && enabled && runningPort !== null && error === null && clientError === null }
  }
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = serial.then(run); serial = next.catch(() => {}); return next
  }
  const save = async () => {
    token ??= randomBytes(32).toString('hex')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ enabled, port: configuredPort, token, clients }), { mode: 0o600 })
    await rename(temporary, path)
  }
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
  // WHY each client reconciles on its own (#1539): with Codex as the only
  // client, any file conflict stopped the listener, since a server nobody can
  // reach is just an open port. With two clients, one client's conflict (an
  // edited skill, a user-built server under the reserved name) must not cut
  // off the other client that set up fine. The listener therefore stops only
  // when EVERY client failed. With a single client that is the old rule
  // exactly, and externalCodexIntegration.test.ts still pins it.
  //
  // Sequential, not Promise.all: the clients write to unrelated files, but
  // running them one at a time keeps each compare-before-replace window short
  // and the error order deterministic.
  //
  // A deselected client is reconciled with `null`, the same as a global
  // disable: unticking Claude Code must actually remove our entry and skill
  // from ~/.claude.json and ~/.claude/skills, not just stop updating them and
  // leave a dead credential behind. Only selected clients count towards the
  // "every client failed" rule; with nothing selected the listener still runs,
  // for clients configured by hand from the copy buttons.
  const reconcileClients = async (connection: { url: string; token: string } | null) => {
    clientErrors.clear()
    for (const integration of integrations) {
      try { await integration.reconcile(clients[integration.client] ? connection : null) } catch (cause) { clientErrors.set(integration.client, message(cause)) }
    }
    const selected = integrations.filter(integration => clients[integration.client])
    if (connection && selected.length > 0 && selected.every(integration => clientErrors.has(integration.client))) {
      throw new Error(selected.map(integration => `${integration.client}: ${clientErrors.get(integration.client)}`).join('; '))
    }
  }
  const reconcile = async () => {
    await port.stop(); runningPort = null; error = null
    try {
      if (enabled) {
        runningPort = await port.start(configuredPort, token!)
        await reconcileClients({ url: `http://127.0.0.1:${runningPort}/mcp`, token: token! })
      } else await reconcileClients(null)
    } catch (cause) {
      await port.stop(); runningPort = null
      error = message(cause)
    }
    return status()
  }
  return {
    status,
    initialize: () => exclusive(async () => {
      try {
        const saved = persistedSchema.parse(JSON.parse(await readFile(path, 'utf8')))
        enabled = saved.enabled; configuredPort = saved.port; token = saved.token; clients = saved.clients
        await reconcile()
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') error = `Could not load external control settings: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }),
    dispose: () => exclusive(async () => { await port.stop(); runningPort = null }),
    capabilities: [
      defineCapability({ id: 'externalControl.status', title: 'External operator connection', execution: 'main', effect: 'read',
        description: 'App-wide external control connection status, shared by all windows. Never returns credentials.', input: z.object({}).strict(), output: externalConnectionStatusSchema, handler: status }),
      defineCapability({ id: 'externalControl.configure', visibility: 'application', title: 'Configure external operator connection', execution: 'main', effect: 'mutation',
        description: 'Local settings action: enable or disable the external operator server and optionally choose its loopback port. Disabled by default; never added to internal agents.',
        input: z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535).optional(), rotateKey: z.boolean().default(false),
          clients: z.object({ codex: z.boolean().optional(), claude: z.boolean().optional() }).strict().optional()
            .describe('Which external clients get the managed global connection and skill. Omitted keys keep their current choice.') }).strict(),
        output: externalConnectionStatusSchema,
        handler: input => exclusive(async () => {
          const previous = { enabled, configuredPort, token, clients }
          enabled = input.enabled; configuredPort = input.port ?? configuredPort
          clients = { codex: input.clients?.codex ?? clients.codex, claude: input.clients?.claude ?? clients.claude }
          if (input.rotateKey) token = randomBytes(32).toString('hex')
          try { await save() } catch (cause) {
            enabled = previous.enabled; configuredPort = previous.configuredPort; token = previous.token; clients = previous.clients
            throw cause
          }
          return reconcile()
        }),
      }),
      defineCapability({ id: 'externalControl.copyConnection', visibility: 'application', title: 'Copy external MCP configuration', execution: 'main', effect: 'mutation',
        description: 'Local settings action: copy a private connection configuration to the clipboard. The token is never returned in a tool result or recorded in operation history.',
        input: z.object({ format: z.enum(['codex', 'json']).default('codex') }).strict(), output: z.object({ copied: z.literal(true) }),
        handler: ({ format }) => exclusive(async () => {
          if (!token || !runningPort) throw new ControlError('unavailable', 'Enable the external server before copying its connection')
          const url = status().url!
          port.copy(format === 'codex'
            ? `[mcp_servers.agent-code-control]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n`
            : JSON.stringify({ mcpServers: { 'agent-code-control': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2))
          return { copied: true as const }
        }),
      }),
    ],
  }
}
