import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ControlOperatorPort } from '@control-sdk'
import { createOperatorMcpServer } from './tools'

// No application imports here. The removable transport only sees the public
// SDK caller supplied by main composition. Each authenticated HTTP request gets
// a stateless MCP transport; renderer windows can appear/reload independently
// without stale per-client closures or a second inventory of app state.
export class ExternalControlMcpHost {
  private server: Server | null = null
  private readonly active = new Set<StreamableHTTPServerTransport>()
  constructor(private readonly port: ControlOperatorPort) {}

  async start(portNumber: number, token: string): Promise<number> {
    if (this.server) throw new Error('External control server is already running')
    const server = createServer((request, response) => { void this.handle(request, response, token).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }) })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const error = (error: Error) => { server.off('listening', listening); reject(error) }
        const listening = () => { server.off('error', error); resolve() }
        server.once('error', error); server.once('listening', listening)
        server.listen(portNumber, '127.0.0.1')
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('External control did not bind a TCP port')
      return address.port
    } catch (error) { this.server = null; server.close(); throw error }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    // Revocation closes existing sockets too. A plain server.close() waits for
    // keep-alive clients and can make the Disabled switch look ineffective.
    server.closeAllConnections()
    await Promise.allSettled([...this.active].map(transport => transport.close()))
    this.active.clear()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const address = this.server?.address()
    const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : null
    // External desktop clients do not use browser Origin. Reject every browser
    // origin and nonliteral Host, including localhost aliases: binding loopback
    // alone does not stop DNS rebinding. Credentials never enter audit payloads.
    if (!expectedHost || request.headers.host !== expectedHost || request.headers.origin) { response.writeHead(403).end(); return }
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    const pieces: Buffer[] = []
    let bytes = 0
    for await (const piece of request) {
      bytes += piece.length
      if (bytes > 2 * 1024 * 1024) { response.writeHead(413).end(); return }
      pieces.push(piece)
    }
    const text = Buffer.concat(pieces).toString('utf8')
    const id = randomUUID()
    let body: unknown
    try { body = JSON.parse(text) } catch {
      await this.port.recordTransport({ id, method: 'invalid-json', direction: 'request', payload: { text } })
      await this.port.recordTransport({ id, method: 'invalid-json', direction: 'failure', payload: { status: 400 } })
      response.writeHead(400).end(); return
    }
    const method = body && typeof body === 'object' && 'method' in body ? String(body.method) : 'invalid-request'
    await this.port.recordTransport({ id, method, direction: 'request', payload: body })
    const mcp = createOperatorMcpServer(this.port)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    const send = transport.send.bind(transport)
    transport.send = async (message, options) => {
      await this.port.recordTransport({ id, method, direction: 'response', payload: message })
      return send(message, options)
    }
    this.active.add(transport)
    try {
      await mcp.connect(transport)
      await transport.handleRequest(request, response, body)
      // Notifications produce HTTP 202 with no JSON-RPC response. Record that
      // actual transport disposition as well so a request isn't left unresolved.
      if (response.statusCode === 202 || response.statusCode >= 400) await this.port.recordTransport({ id, method,
        direction: response.statusCode >= 400 ? 'failure' : 'response', payload: { httpStatus: response.statusCode } })
    } catch (error) {
      await this.port.recordTransport({ id, method, direction: 'failure', payload: { message: error instanceof Error ? error.message : String(error) } })
      throw error
    } finally { this.active.delete(transport); await mcp.close() }
  }
}
