import { EventEmitter } from 'events'
import { join, resolve } from 'path'
import { mkdir } from 'fs/promises'

import { ClaudeCodeHeadless } from '../../claude-code-headless/dist/ClaudeCodeHeadless.js'
import { createProxyServer } from '../../claude-code-headless/dist/testing/proxy-testing/proxyServer.js'
import {
  IncrementalSseParser,
  parseAnthropicEvents,
  parseAnthropicEventsFromSse,
} from '../../claude-code-headless/dist/testing/proxy-testing/sseParser.js'
import { spawnClaudeWithProxy } from '../../claude-code-headless/dist/testing/proxy-testing/spawnClaudeWithProxy.js'

export class DemoSession extends EventEmitter {
  constructor(options = {}) {
    super()
    this.cwd = options.cwd ?? process.env.CC_PROXY_TEST_CWD ?? process.cwd()
    this.binary =
      options.binary ?? process.env.CC_PROXY_TEST_CLAUDE_BINARY ?? 'claude'
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.proxy = null
    this.pty = null
    this.headless = null
    this.streamText = ''
    this.rawEvents = []
    this.streams = new Map()
    this.status = 'starting'
  }

  async start() {
    const runtimeRoot = resolve(process.cwd(), '.proxy-testing', 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    this.proxy = await createProxyServer(runtimeRoot)
    await this.proxy.start()

    this.pty = spawnClaudeWithProxy({
      cwd: this.cwd,
      binary: this.binary,
      cols: this.cols,
      rows: this.rows,
      proxyUrl: this.proxy.info.proxyUrl,
      caCertPath: this.proxy.info.caCertPath,
    })

    this.pty.onData((data) => {
      this.emit('terminal-data', data)
    })

    this.headless = new ClaudeCodeHeadless({
      pty: this.pty,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      snapshotIntervalMs: 16,
    })

    this.headless.on('activity', (status) => {
      this.status = status
      this.emit('status', status)
    })
    this.headless.on('idle', () => {
      this.status = 'idle'
      this.emit('status', 'idle')
    })
    this.headless.on('exit', ({ exitCode, signal }) => {
      this.emit('status', `exited (${exitCode}${signal ? `, ${signal}` : ''})`)
      this.emit('exit', { exitCode, signal })
    })

    this.proxy.on('event', (event) => {
      this.handleProxyEvent(event)
    })
    this.proxy.on('stderr', (text) => {
      this.emit('proxy-log', text)
    })

    const { projectDir } = await this.headless.start()
    this.emit('ready', {
      cwd: this.cwd,
      projectDir,
      proxyUrl: this.proxy.info.proxyUrl,
      caCertPath: this.proxy.info.caCertPath,
    })
  }

  handleProxyEvent(event) {
    const kind = typeof event.kind === 'string' ? event.kind : ''
    const url = typeof event.url === 'string' ? event.url : ''
    const flowId = String(event.flow_id ?? '')
    if (!url.includes('/v1/messages')) return

    if (kind === 'request') {
      this.streams.set(flowId, {
        decoder: new TextDecoder('utf-8'),
        parser: new IncrementalSseParser(),
        text: '',
      })
      this.emit('stream-debug', { kind, flowId, url })
      return
    }

    if (kind === 'response') {
      const body = typeof event.body === 'string' ? event.body : null
      if (!body) return
      for (const parsed of parseAnthropicEvents(body)) {
        this.applyParsedEvent(parsed)
      }
      return
    }

    const stream = this.streams.get(flowId)
    if (!stream) return

    if (kind === 'response-chunk') {
      const chunkB64 = typeof event.chunk_b64 === 'string' ? event.chunk_b64 : ''
      if (!chunkB64) return
      const bytes = Buffer.from(chunkB64, 'base64')
      const decoded = stream.decoder.decode(bytes, { stream: true })
      const sseEvents = stream.parser.append(decoded)
      for (const parsed of parseAnthropicEventsFromSse(sseEvents)) {
        this.applyParsedEvent(parsed)
      }
      return
    }

    if (kind === 'response-end') {
      const tail = stream.decoder.decode()
      const tailSse = stream.parser.append(tail)
      const flushed = stream.parser.flush()
      for (const parsed of parseAnthropicEventsFromSse([...tailSse, ...flushed])) {
        this.applyParsedEvent(parsed)
      }
      this.streams.delete(flowId)
    }
  }

  applyParsedEvent(parsed) {
    this.rawEvents.push(parsed)
    if (this.rawEvents.length > 200) this.rawEvents.shift()

    if (parsed.type === 'message_start') {
      this.streamText = ''
      this.emit('stream-reset')
    } else if (parsed.type === 'text_delta') {
      this.streamText += parsed.text
      this.emit('stream-text', this.streamText)
    }

    this.emit('stream-event', parsed)
  }

  write(data) {
    this.headless?.write(data)
  }

  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.headless?.resize(cols, rows)
  }

  async stop() {
    try {
      await this.headless?.stop()
    } catch {
      // best-effort
    }
    try {
      this.pty?.kill()
    } catch {
      // best-effort
    }
    try {
      await this.proxy?.stop()
    } catch {
      // best-effort
    }
    this.proxy = null
    this.pty = null
    this.headless = null
  }
}
