import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ControlError, defineCapability, externalConnectionStatusSchema, type ExternalConnectionStatus } from '@control-sdk'

const persistedSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

// Main owns this preference for the whole app, not whichever renderer happened
// to hydrate last. Two settings windows cannot start competing listeners or
// rotate each other's key through independent localStorage copies. The secret
// never appears in SDK results or call history: copying is a local clipboard
// action that reports only success, while disk state is private to this user.
export function createExternalControlSettings(directory: string, port: {
  start(port: number, token: string): Promise<number>
  stop(): Promise<void>
  copy(text: string): void
}) {
  let enabled = false
  let configuredPort = 47653
  let token: string | undefined
  let runningPort: number | null = null
  let error: string | null = null
  let serial: Promise<unknown> = Promise.resolve()
  const path = join(directory, 'external-control.json')
  const status = (): ExternalConnectionStatus => ({ enabled, running: runningPort !== null, port: configuredPort,
    url: runningPort === null ? null : `http://127.0.0.1:${runningPort}/mcp`, serverName: 'agent-code-control', error })
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = serial.then(run); serial = next.catch(() => {}); return next
  }
  const save = async () => {
    token ??= randomBytes(32).toString('hex')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ enabled, port: configuredPort, token }), { mode: 0o600 })
    await rename(temporary, path)
  }
  const reconcile = async () => {
    await port.stop(); runningPort = null; error = null
    if (enabled) {
      try { runningPort = await port.start(configuredPort, token!) }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    }
    return status()
  }
  return {
    status,
    initialize: () => exclusive(async () => {
      try {
        const saved = persistedSchema.parse(JSON.parse(await readFile(path, 'utf8')))
        enabled = saved.enabled; configuredPort = saved.port; token = saved.token
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
        input: z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535).optional(), rotateKey: z.boolean().default(false) }).strict(),
        output: externalConnectionStatusSchema,
        handler: input => exclusive(async () => {
          const previous = { enabled, configuredPort, token }
          enabled = input.enabled; configuredPort = input.port ?? configuredPort
          if (input.rotateKey) token = randomBytes(32).toString('hex')
          try { await save() } catch (cause) {
            enabled = previous.enabled; configuredPort = previous.configuredPort; token = previous.token
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
