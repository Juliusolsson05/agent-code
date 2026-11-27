// The session against a scripted `agy acp` stand-in that answers with the
// frame shapes recorded from agy 1.5.15 (initialize, session/new,
// session/load replay, session/prompt with a permission request). Real
// streams, real JSON-RPC framing; only the agent is a script.

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { AntigravityAcpSession } from './AntigravityAcpSession.js'
import type { AntigravityRow } from './transcript/assembler.js'

type Frame = Record<string, unknown> & { id?: string | number; method?: string; params?: any }

function fakeAgy(script: (frame: Frame, send: (frame: Frame) => void) => void) {
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  const sent: Frame[] = []
  let buffer = ''
  const send = (frame: Frame) => fromAgent.write(JSON.stringify(frame) + '\n')
  toAgent.setEncoding('utf8')
  toAgent.on('data', chunk => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const frame = JSON.parse(buffer.slice(0, newline)) as Frame
      buffer = buffer.slice(newline + 1)
      sent.push(frame)
      script(frame, send)
      newline = buffer.indexOf('\n')
    }
  })
  return { input: fromAgent, output: toAgent, sent, send }
}

const update = (sessionId: string, value: Record<string, unknown>): Frame => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
const INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }

describe('AntigravityAcpSession', () => {
  it('creates a session, streams a turn, and answers a permission request through respondPermission', async () => {
    const agy = fakeAgy((frame, send) => {
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: INIT })
      if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'sess-1', models: {} } })
      if (frame.method === 'session/prompt') {
        send(update('sess-1', { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'echo hi' } }))
        send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'sess-1', toolCall: { toolCallId: 'c1', name: 'run_command', title: 'echo hi', rawInput: { CommandLine: 'echo hi' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
        ;(globalThis as any).__promptId = frame.id
      }
      if (frame.id === 'perm-1' && frame.result) {
        send(update('sess-1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'hi' } }))
        send(update('sess-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }))
        send({ jsonrpc: '2.0', id: (globalThis as any).__promptId, result: { stopReason: 'end_turn' } })
      }
    })
    const session = new AntigravityAcpSession({ input: agy.input, output: agy.output, cwd: '/work' })
    const rows: AntigravityRow[] = []
    session.on('row', row => rows.push(row))
    const snapshots: any[] = []
    session.on('conditions', snapshot => {
      snapshots.push(snapshot)
      const state = snapshot.conditions['antigravity.permission']?.state as { requestKey: string } | undefined
      if (state) expect(session.respondPermission(state.requestKey, 'nope')).toBe(false)
      if (state) expect(session.respondPermission(state.requestKey, 'allow')).toBe(true)
    })
    expect(await session.start()).toEqual({ sessionId: 'sess-1', resumed: false })
    const { accepted, finished } = session.prompt('say hi')
    await accepted
    expect(await finished).toBe('end_turn')
    expect(snapshots[0].conditions['antigravity.permission'].actions.map((action: any) => action.label)).toEqual(['Allow', 'Deny'])
    expect(agy.sent.find(frame => frame.id === 'perm-1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    expect(rows.map(row => `${row.role}:${row.text ?? row.tool?.output}`)).toEqual(['user:say hi', 'tool:hi', 'assistant:done'])
    expect(session.getActivity()).toEqual({ active: false, status: 'idle' })
  })

  it('resumes with session/load and publishes the replay between a reset and caught-up', async () => {
    const agy = fakeAgy((frame, send) => {
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: INIT })
      if (frame.method === 'session/load') {
        expect(frame.params.sessionId).toBe('old')
        send(update('old', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier prompt' } }))
        send(update('old', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } }))
        send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'old' } })
      }
    })
    const session = new AntigravityAcpSession({ input: agy.input, output: agy.output, cwd: '/work', resumeSessionId: 'old' })
    const order: string[] = []
    session.on('history', ({ kind }) => order.push(kind))
    session.on('row', row => order.push(row.key))
    session.on('semantic', () => order.push('semantic'))
    expect(await session.start()).toEqual({ sessionId: 'old', resumed: true })
    expect(order).toEqual(['reset', 'ag:old:0', 'ag:old:1', 'caught-up'])
  })

  it('falls back to a new conversation when agy refuses the load, without publishing the failed replay', async () => {
    const agy = fakeAgy((frame, send) => {
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: INIT })
      if (frame.method === 'session/load') {
        send(update('gone', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'partial' } }))
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'session not found' } })
      }
      if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'new-1' } })
    })
    const session = new AntigravityAcpSession({ input: agy.input, output: agy.output, cwd: '/work', resumeSessionId: 'gone' })
    const order: string[] = []
    session.on('history', ({ kind, conversationChanged }) => order.push(`${kind}${conversationChanged ? ':changed' : ''}`))
    session.on('row', row => order.push(row.key))
    expect(await session.start()).toEqual({ sessionId: 'new-1', resumed: false })
    expect(order).toEqual(['reset:changed', 'caught-up'])
    expect(session.getRows()).toEqual([])
  })

  it('fails a turn locally when agy ignores the cancel', async () => {
    const agy = fakeAgy((frame, send) => {
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: INIT })
      if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 's' } })
      // session/prompt and session/cancel: never answered.
    })
    const session = new AntigravityAcpSession({ input: agy.input, output: agy.output, cwd: '/work', cancelGraceMs: 30 })
    await session.start()
    const { accepted, finished } = session.prompt('stuck')
    await accepted
    session.cancel()
    await expect(finished).rejects.toThrow(/did not stop the turn/)
    expect(session.isTurnActive()).toBe(false)
    expect(agy.sent.some(frame => frame.method === 'session/cancel')).toBe(true)
  })

  it('cancels a running turn with session/cancel and answers open permission asks as cancelled', async () => {
    const agy = fakeAgy((frame, send) => {
      if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: INIT })
      if (frame.method === 'session/new') send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 's' } })
      if (frame.method === 'session/prompt') {
        ;(globalThis as any).__cancelPrompt = frame.id
        send({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 't' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } })
      }
      if (frame.method === 'session/cancel') send({ jsonrpc: '2.0', id: (globalThis as any).__cancelPrompt, result: { stopReason: 'cancelled' } })
    })
    const session = new AntigravityAcpSession({ input: agy.input, output: agy.output, cwd: '/work' })
    await session.start()
    const { finished } = session.prompt('long job')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(session.getActivity().status).toBe('waiting-permission')
    session.cancel()
    expect(await finished).toBe('cancelled')
    expect(agy.sent.find(frame => frame.id === 9)?.result).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
