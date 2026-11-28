import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { createPrivateMcpDirectory } from '@providers/shared/runtime/builtInMcpLaunch.js'
import type { SessionOptions } from '@shared/types/session.js'
import { resolveAntigravityNativeMcpRelay, resolveAntigravityScriptRunner } from './runtimeScripts.js'
import { type AntigravityUserMcpConfig, resolveAntigravityUserMcpEntries } from './userMcpEntries.js'

/** Only a public service address can go in an agent-readable workspace. Let native agy
 * receive its HTTP 401 and perform OAuth. A query, userinfo, fragment or custom path may
 * contain a credential. Match the original spelling too: URL normalization discards
 * dot segments, so testing pathname alone would write the original secret onto disk. */
function nativeOAuthUrl(entry: AntigravityUserMcpConfig): string | undefined {
  if (!('serverUrl' in entry) || Object.keys(entry.headers).length || !URL.canParse(entry.serverUrl)) return
  const url = new URL(entry.serverUrl)
  if (url.protocol !== 'https:' || !['/', '/mcp', '/mcp/'].includes(url.pathname)) return
  if (entry.serverUrl === url.origin || entry.serverUrl === url.origin + url.pathname) return entry.serverUrl
}

/** Native agy reads an additional workspace's .agents/mcp_config.json at launch, including
 * explicit resumes. It does not expand environment variables there, and an agy shell or
 * unrelated MCP process inherits agy's environment. Keep the original credentials in main.
 * A stolen relay grant can speak only MCP to that one registered server until this pane
 * closes; the relay has no API to retrieve the server config, headers or environment. */
export async function openAntigravityNativeMcp(options: SessionOptions) {
  const publicEntries: Array<[string, { serverUrl: string }]> = []
  const entries: Array<{ name: string; config: AntigravityUserMcpConfig }> = []
  for (const server of resolveAntigravityUserMcpEntries(options.userMcpServers ?? [])) {
    const serverUrl = nativeOAuthUrl(server.config)
    if (serverUrl) publicEntries.push([server.name, { serverUrl }])
    else entries.push(server)
  }
  for (const server of options.builtInMcpServers ?? []) {
    const headers = { ...server.headers, ...(server.bearerToken === undefined ? {} : { Authorization: 'Bearer ' + server.bearerToken }) }
    entries.push({ name: server.name, config: { serverUrl: server.url, headers } })
  }
  if (!entries.length && !publicEntries.length) return undefined

  const directory = await createPrivateMcpDirectory()
  const workspace = join(directory, 'workspace')
  const bootstraps = join(directory, 'private')
  const grants = new Map<string, AntigravityUserMcpConfig>()
  let ownerPid: number | null = null
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(3000, () => socket.destroy())
    const authenticate = () => {
      // Use a fixed-size handshake: a split TCP packet must not turn half a token
      // into an authentication failure, or swallow MCP bytes following the token.
      const frame: Buffer | null = socket.read(36)
      if (!frame) return
      socket.removeListener('readable', authenticate)
      const entry = grants.get(frame.subarray(0, 32).toString('hex'))
      if (!entry || frame.readUInt32BE(32) !== ownerPid) return socket.destroy()
      socket.setTimeout(0)
      void connectNativeMcp(socket, entry, options).catch(() => socket.destroy())
    }
    socket.on('readable', authenticate)
  })
  const close = () => {
    grants.clear()
    if (server.listening) server.close()
    for (const socket of sockets) socket.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    let port: number | undefined
    if (entries.length) {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); ok() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Could not open the Antigravity MCP relay.')
      port = address.port
      mkdirSync(bootstraps, { mode: 0o700 })
    }
    const relayEntries = entries.map(({ name, config }) => {
      // agy passes the parent environment to every MCP child and shell. Its per-entry
      // env contains only this private bootstrap path. The grant itself stays outside
      // the model's additional workspace and expires with this pane's listener.
      const bootstrap = join(bootstraps, randomBytes(12).toString('hex'))
      const grant = randomBytes(32)
      writeFileSync(bootstrap, grant, { mode: 0o600 })
      grants.set(grant.toString('hex'), config)
      return [name, {
        command: resolveAntigravityScriptRunner(),
        args: [resolveAntigravityNativeMcpRelay(), String(port)],
        env: { ELECTRON_RUN_AS_NODE: '1', AGENT_CODE_AGY_RELAY_BOOTSTRAP: bootstrap },
      }] as const
    })
    const mcpServers = Object.fromEntries([...publicEntries, ...relayEntries])
    const configDir = join(workspace, '.agents')
    mkdirSync(configDir, { mode: 0o700, recursive: true })
    writeFileSync(join(configDir, 'mcp_config.json'), JSON.stringify({ mcpServers }), { mode: 0o600 })
    return { directory: workspace, setOwner(pid: number | null) { ownerPid = pid }, close }
  } catch (error) {
    close()
    throw error
  }
}

/** Transport-level forwarding preserves resource/prompt methods, cancellation, server
 * instructions, paginated results and tool errors without translating any tool schemas.
 * HTTP redirects are disabled so arbitrary API-key headers cannot reach a different origin. */
async function connectNativeMcp(socket: Socket, entry: AntigravityUserMcpConfig, options: SessionOptions) {
  const downstream = new StdioServerTransport(socket, socket)
  const upstream: Transport = 'command' in entry
    ? new StdioClientTransport({ ...entry, cwd: options.cwd, stderr: 'ignore', env: {
      ...(options.env?.PATH ? { PATH: options.env.PATH } : {}), ...entry.env,
    } })
    : new StreamableHTTPClientTransport(new URL(entry.serverUrl), {
      requestInit: { headers: entry.headers, redirect: 'error' },
    })
  socket.once('close', () => {
    void downstream.close()
    void upstream.close().catch(() => {})
  })
  let initializeId: string | number | undefined
  upstream.onclose = () => socket.destroy()
  downstream.onerror = () => socket.destroy()
  upstream.onmessage = message => {
    if (upstream instanceof StreamableHTTPClientTransport && 'result' in message && message.id === initializeId && typeof message.result.protocolVersion === 'string') {
      upstream.setProtocolVersion(message.result.protocolVersion)
    }
    void downstream.send(message).catch(() => socket.destroy())
  }
  downstream.onmessage = message => {
    // agy extends stdio with an optional discover probe before MCP initialize.
    // Streamable HTTP servers can reject any pre-initialize request at the HTTP
    // layer. Answer the optional extension locally; agy then negotiates MCP.
    if ('method' in message && message.method === 'server/discover' && 'id' in message && upstream instanceof StreamableHTTPClientTransport) {
      void downstream.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }).catch(() => socket.destroy())
      return
    }
    if ('method' in message && message.method === 'initialize' && 'id' in message) initializeId = message.id
    void upstream.send(message).catch(() => {
      if ('method' in message && 'id' in message) {
        // An upstream CLI or server can include credentials in its error text.
        void downstream.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'MCP upstream request failed' } }).catch(() => socket.destroy())
      } else socket.destroy()
    })
  }
  await upstream.start()
  if (socket.destroyed) { await upstream.close(); return }
  await downstream.start()
}
