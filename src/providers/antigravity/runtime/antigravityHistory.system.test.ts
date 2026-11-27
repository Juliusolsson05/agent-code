import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { loadAntigravityHistoryChunk, replayAntigravityConversation } from './antigravityHistory.js'

// The replay fallback of Antigravity history: a pane that is NOT live (the
// catalog preview, MCP read_agent on a closed agent, View Prompts) gets its
// rows from a short-lived `agy acp` that answers session/load. The agent is a
// scripted stand-in on PassThrough streams (real JSON-RPC framing); one test
// spawns a real, nonexistent executable to pin what happens when agy is not
// installed. The real `agy` is never run.

type Frame = Record<string, unknown> & { id?: string | number; method?: string; params?: any }

class FakeAgy extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly sent: Frame[] = []
  readonly kill = vi.fn(() => {
    this.stdout.end()
    setImmediate(() => this.emit('exit', null, 'SIGTERM'))
    return true
  })

  constructor(script: (frame: Frame, agy: FakeAgy) => void) {
    super()
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, newline)) as Frame
        buffer = buffer.slice(newline + 1)
        this.sent.push(frame)
        script(frame, this)
      }
    })
  }

  send(frame: Frame): void {
    this.stdout.write(JSON.stringify(frame) + '\n')
  }
}

const text = (sessionUpdate: string, value: string) => ({ sessionUpdate, content: { type: 'text', text: value } })

function replayingAgy(sessionId: string, updates: Array<Record<string, unknown>>) {
  return new FakeAgy((frame, agy) => {
    if (frame.method === 'initialize') agy.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    if (frame.method === 'session/load') {
      for (const update of updates) agy.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
      agy.send({ jsonrpc: '2.0', id: frame.id, result: { sessionId } })
    }
  })
}

describe('Antigravity history replay', () => {
  it('a conversation that is not live is replayed through session/load, paged, and the agy it ran is killed', async () => {
    const agy = replayingAgy('closed-conv', [
      text('user_message_chunk', 'first prompt'),
      text('agent_message_chunk', 'first answer'),
      text('user_message_chunk', 'second prompt'),
      text('agent_message_chunk', 'second answer'),
    ])
    const spawn = vi.fn(() => agy as unknown as ChildProcessWithoutNullStreams)

    const chunk = await loadAntigravityHistoryChunk({ cwd: '/work/project', providerSessionId: 'closed-conv', limit: 3 }, { binary: '/opt/agy/bin/agy', spawn })

    expect(spawn).toHaveBeenCalledWith('/opt/agy/bin/agy', ['acp'], { cwd: '/work/project' })
    // A read-only replay hands agy no MCP servers and runs no prompt.
    expect(agy.sent.map(frame => frame.method)).toEqual(['initialize', 'session/load'])
    expect(agy.sent[1]!.params).toEqual({ sessionId: 'closed-conv', cwd: '/work/project', mcpServers: [] })
    expect(chunk.entries.map(entry => [entry.key, entry.text])).toEqual([
      ['ag:closed-conv:1', 'first answer'],
      ['ag:closed-conv:2', 'second prompt'],
      ['ag:closed-conv:3', 'second answer'],
    ])
    expect(chunk).toMatchObject({ hasMore: true, totalEntries: 4, oldestMarker: 'ag:closed-conv:1' })
    expect(agy.kill).toHaveBeenCalledTimes(1)
  })

  it('an agy that dies before answering is an `unreadable` history error, not a hang', async () => {
    const agy = new FakeAgy(() => {})
    const spawn = vi.fn(() => {
      setImmediate(() => agy.stdout.end())
      return agy as unknown as ChildProcessWithoutNullStreams
    })
    await expect(loadAntigravityHistoryChunk({ cwd: '/work', providerSessionId: 'dead-conv', limit: 5 }, { spawn })).rejects.toMatchObject({
      code: 'unreadable',
      message: expect.stringMatching(/^unreadable: Antigravity history unavailable: /),
    })
    expect(agy.kill).toHaveBeenCalled()
  })

  it('an agy that cannot be spawned rejects the replay instead of throwing an unhandled child error in main', async () => {
    // Node reports ENOENT/EACCES from spawn as an 'error' EVENT on the child
    // (never 'exit'); with no listener that event is rethrown as an uncaught
    // exception — in the app, in Electron main. Vitest fails the run on it.
    const started = Date.now()
    await expect(replayAntigravityConversation('any-conv', process.cwd(), { binary: '/nonexistent/agent-code-test/agy' })).rejects.toThrow()
    // No 'exit' ever comes for a process that never started; the replay must
    // not sit out its 2 s exit grace period waiting for one.
    expect(Date.now() - started).toBeLessThan(1500)
  })
})
