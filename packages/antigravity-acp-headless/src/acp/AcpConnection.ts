// JSON-RPC 2.0 over newline-delimited stdio: the transport of the Agent
// Client Protocol as `agy acp` speaks it (one JSON object per line, both
// directions; the agent also SENDS requests, e.g. session/request_permission).
//
// WHY a small client of its own instead of grok-code-headless's GrokAcpClient:
// that one lives in another provider's package (a provider→provider import
// the boundary tests forbid) and is shaped around Grok's leader socket. The
// protocol surface agy needs here is small: requests with ids, notifications,
// and answering the agent's own requests.
//
// Safety rules, each from a failure the sibling packages hit:
// - Error messages never include the frame text: a frame can carry a prompt,
//   a tool result or an MCP credential, and errors reach logs and the UI.
// - Every pending request settles when the stream closes, so no caller hangs
//   on a dead agent.
// - A frame larger than MAX_FRAME_BYTES closes the connection instead of
//   growing a buffer without bound.

import type { Readable, Writable } from 'node:stream'

const MAX_FRAME_BYTES = 64 * 1024 * 1024

export class AcpError extends Error {
  constructor(
    readonly code: 'closed' | 'remote' | 'protocol' | 'timeout',
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

export type AcpIncomingRequest = { id: string | number; method: string; params: unknown }

type Pending = { resolve(value: unknown): void; reject(error: AcpError): void; timer: ReturnType<typeof setTimeout> | null }

export type AcpConnectionOptions = {
  onNotification(method: string, params: unknown): void
  onRequest(request: AcpIncomingRequest): void
  onClose(reason: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class AcpConnection {
  private buffer = ''
  private nextId = 1
  private closed = false
  private readonly pending = new Map<string | number, Pending>()

  private readonly listeners: Array<[Readable | Writable, string, (...args: never[]) => void]> = []

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly options: AcpConnectionOptions) {
    input.setEncoding('utf8')
    this.listen(input, 'data', (chunk: string) => this.onData(chunk))
    this.listen(input, 'end', () => this.close('stream ended'))
    this.listen(input, 'close', () => this.close('stream closed'))
    this.listen(input, 'error', () => this.close('stream error'))
    this.listen(output, 'error', () => this.close('write error'))
  }

  private listen(stream: Readable | Writable, event: string, handler: (...args: never[]) => void): void {
    stream.on(event, handler as (...args: unknown[]) => void)
    this.listeners.push([stream, event, handler])
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Send a request. `timeoutMs: null` waits until the response or the close:
   * session/prompt answers only when its whole turn ends, which can be hours.
   */
  request(method: string, params: unknown, timeoutMs: number | null = 60_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpError('closed', `ACP ${method}: connection closed`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        if (this.pending.delete(id)) reject(new AcpError('timeout', `ACP ${method}: no response in ${timeoutMs} ms`))
      }, timeoutMs)
      timer?.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: string | number, result: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: string | number, code: number, message: string): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    // Detach and drop the buffer: after a close (an oversized frame, a write
    // error) no further line may reach rows or conditions, and a frame that
    // tripped the size cap must not keep growing in memory.
    for (const [stream, event, handler] of this.listeners.splice(0)) stream.off(event, handler as (...args: unknown[]) => void)
    // Keep one no-op error listener: a late stream error with no listener at
    // all would be thrown as an uncaught exception in main.
    this.input.on('error', () => {})
    this.output.on('error', () => {})
    this.buffer = ''
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new AcpError('closed', `ACP connection closed (${reason})`))
    }
    this.pending.clear()
    this.options.onClose(reason)
  }

  private write(message: unknown): void {
    try {
      this.output.write(JSON.stringify(message) + '\n')
    } catch {
      this.close('write failed')
    }
  }

  private onData(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes('\n')) {
      this.close('frame too large')
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1 && !this.closed) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // agy logs to stderr, not stdout; a non-JSON stdout line is a protocol
      // slip we skip rather than tearing down a working session over it.
      return
    }
    if (!isRecord(message)) return
    const id = message.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    if (typeof message.method === 'string') {
      if (hasId) this.options.onRequest({ id, method: message.method, params: message.params })
      else this.options.onNotification(message.method, message.params)
      return
    }
    if (!hasId) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (isRecord(message.error)) {
      const rpcCode = typeof message.error.code === 'number' ? message.error.code : undefined
      const text = typeof message.error.message === 'string' ? message.error.message.slice(0, 500) : 'error'
      pending.reject(new AcpError('remote', text, rpcCode))
    } else {
      pending.resolve(message.result)
    }
  }
}
