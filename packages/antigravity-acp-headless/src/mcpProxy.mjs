// Agent Code built-in MCP for Antigravity (agy): a stdio MCP server that
// forwards to the per-session HTTP endpoint Agent Code minted for this pane.
//
// WHY stdio and not an HTTP server entry in session/new: ACP lets a client
// hand the agent MCP servers per session, but HTTP servers only when the
// agent advertises `mcpCapabilities.http`, and agy 1.5.15 advertises none.
// stdio is the one transport every ACP agent must accept, so the pane names
// this script (run by Agent Code's own Electron in node mode) and the script
// speaks Streamable HTTP to the real endpoint. Same shape as the Pi bridge's
// MCP proxy (pi-terminal-headless src/bridge/extension.ts).
//
// Contract with AntigravitySession (app side):
//   AGENT_CODE_ACP_MCP_SERVERS  JSON [{ name, url, headerEnv: {Header: VAR} }]
//   <VAR>                       each header VALUE, so no bearer is in argv
// Both arrive in the server's `env` list in session/new, which agy passes to
// the process it starts; nothing is written to agy's own MCP config.
//
// Behaviour rules:
// - No servers configured (MCP disabled for this agent) → a valid MCP server
//   with zero tools, never a failing one.
// - Upstream tool names pass through unchanged. With several upstream servers
//   a duplicate tool name keeps the FIRST server's tool, because a tool call
//   must map to exactly one endpoint.
// - Plain JavaScript, Node built-ins and global fetch only (Node >= 18): it
//   runs outside any bundle.

const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 120_000

function readServers() {
  let specs
  try {
    specs = JSON.parse(process.env.AGENT_CODE_ACP_MCP_SERVERS || '[]')
  } catch {
    specs = []
  }
  if (!Array.isArray(specs)) return []
  const servers = []
  for (const spec of specs) {
    if (!spec || typeof spec.name !== 'string' || typeof spec.url !== 'string') continue
    const headers = {}
    for (const [header, variable] of Object.entries(spec.headerEnv || {})) {
      const value = process.env[variable]
      if (typeof value === 'string') headers[header] = value
    }
    servers.push({ name: spec.name, url: spec.url, headers })
  }
  return servers
}

function sseMessages(body) {
  const messages = []
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // keep-alive or partial event
    }
  }
  return messages
}

class Upstream {
  constructor(server) {
    this.server = server
    this.nextId = 1
    this.protocolVersion = undefined
  }

  headers() {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...this.server.headers,
    }
  }

  async request(method, params) {
    const id = this.nextId++
    const response = await fetch(this.server.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${this.server.name} ${method}: HTTP ${response.status}`)
    const type = response.headers.get('content-type') || ''
    const messages = type.includes('text/event-stream') ? sseMessages(await response.text()) : [await response.json()]
    const reply = messages.find(message => message && message.id === id)
    if (!reply) throw new Error(`${this.server.name} ${method}: no reply`)
    if (reply.error) {
      const error = new Error(reply.error.message || 'error')
      error.rpc = reply.error
      throw error
    }
    return reply.result
  }

  async notify(method) {
    const response = await fetch(this.server.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    await response.text().catch(() => '')
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-code-acp-mcp-proxy', version: '1' },
    })
    this.protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION
    await this.notify('notifications/initialized')
    return typeof result?.instructions === 'string' && result.instructions.trim() ? result.instructions.trim() : undefined
  }

  async listTools() {
    const tools = []
    let cursor
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      if (Array.isArray(result?.tools)) tools.push(...result.tools)
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  }
}

const upstreams = readServers().map(server => new Upstream(server))
/** tool name -> upstream that owns it */
const owners = new Map()
let discovery = null

function discover() {
  discovery ??= (async () => {
    const instructions = []
    const tools = []
    for (const upstream of upstreams) {
      try {
        const text = await upstream.initialize()
        if (text) instructions.push(text)
        for (const tool of await upstream.listTools()) {
          if (!tool || typeof tool.name !== 'string' || owners.has(tool.name)) continue
          owners.set(tool.name, upstream)
          tools.push(tool)
        }
      } catch (error) {
        process.stderr.write(`agent-code mcp proxy: ${upstream.server.name}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    return { tools, instructions }
  })()
  return discovery
}

process.stdout.on('error', () => process.exit(0))

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  try {
    if (method === 'initialize') {
      const { instructions } = await discover()
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION
      if (isRequest) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'agent_code', version: '1' },
            ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
          },
        })
      }
      return
    }
    if (method === 'tools/list') {
      const { tools } = await discover()
      if (isRequest) send({ jsonrpc: '2.0', id, result: { tools } })
      return
    }
    if (method === 'tools/call') {
      await discover()
      const upstream = owners.get(params?.name)
      if (!upstream) throw Object.assign(new Error(`Unknown tool: ${String(params?.name)}`), { rpc: { code: -32602 } })
      const result = await upstream.request('tools/call', params)
      if (isRequest) send({ jsonrpc: '2.0', id, result })
      return
    }
    if (method === 'ping') {
      if (isRequest) send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    // Notifications (initialized, cancelled, ...) need no answer.
    if (!isRequest) return
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  } catch (error) {
    if (!isRequest) return
    const rpc = error && typeof error === 'object' && error.rpc ? error.rpc : {}
    send({ jsonrpc: '2.0', id, error: { code: typeof rpc.code === 'number' ? rpc.code : -32603, message: error instanceof Error ? error.message : String(error) } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) {
      try {
        void handle(JSON.parse(line))
      } catch {
        // A malformed line has no id to answer; MCP clients never send one.
      }
    }
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
