import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FakeSocket } from 'hermes-headless/testing/fakeSocket'

import { HermesAgentBridge } from './agentBridge.js'
import { bridgeOn, CONNECTION } from './testing/hermesReplay.js'

// The `hermes` MCP domain's bridge (#1512) against RECORDED Hermes sessions
// (hermes-headless research/corpus, recorded against `hermes serve` v0.22.0):
//   S4  — session.create → prompt.submit → a three-tool turn → "All three tools ran."
//   S10 — a turn that stops on an `approval` server request ("delete in root path").
// The replay server below answers each call the client makes with the
// recording's next result for that method and pushes the recorded events in
// order. The one call the recording does not hold is the client's own
// post-turn `session.history`; it is answered with the messages the SAME
// server returned when the recorder reconnected (session.resume) — the
// conversation as Hermes stored it, a mechanical reuse of recorded data.

const dirs: string[] = []
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-bridge-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('hermes_send on a recorded turn (S4)', () => {
  it('opens the agent\'s own conversation, sends, and returns Hermes\' stored reply and tools', async () => {
    const dir = stateDir()
    const { bridge, dials } = bridgeOn('S4', dir)
    const result = await bridge.send('agent-session-1', 'Fix the flaky test', { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 })

    expect(result).toMatchObject({ status: 'replied', conversationId: '20261014_092150_c02da4', reply: 'All three tools ran.' })
    expect((result as { tools: string[] }).tools).toHaveLength(3)
    // A conversation of its own, titled after the agent, never the Telegram thread.
    const create = dials[0]!.sent.find((frame) => frame.method === 'session.create')!
    expect(create.params).toMatchObject({ title: 'Agent Code · Fix the flaky test' })
    // The submit is queued: it can never redirect a turn Hermes is running.
    expect(dials[0]!.sent.find((frame) => frame.method === 'prompt.submit')!.params).toMatchObject({ queued: true })
    // Remembered on disk for the next call (and the next app run).
    expect(JSON.parse(readFileSync(join(dir, 'hermes', 'agent-conversations.json'), 'utf8'))).toEqual({ 'conn-1': { 'agent-session-1': '20261014_092150_c02da4' } })
    // Disconnected afterwards: nothing stays open between calls.
    expect(dials[0]!.readyState).toBe(3)
  }, 30_000)

  it('reads the same conversation back later, from a new bridge (resume, not a second create)', async () => {
    const dir = stateDir()
    await bridgeOn('S4', dir).bridge.send('agent-session-1', 'Fix the flaky test', { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 })

    // The recording's SECOND connection is the recorder resuming that stored conversation.
    const later = bridgeOn('S4', dir, 1)
    const read = await later.bridge.read('agent-session-1', {})
    expect(later.dials[0]!.sent.find((frame) => frame.method === 'session.resume')!.params).toMatchObject({ session_id: '20261014_092150_c02da4' })
    expect(later.dials[0]!.sent.some((frame) => frame.method === 'session.create')).toBe(false)
    expect(read.conversationId).toBe('20261014_092150_c02da4')
    expect(read.messages[0]).toEqual({ role: 'user', text: '[[hh:tools]] Run the tools.' })
    expect(read.messages.at(-1)).toEqual({ role: 'hermes', text: 'All three tools ran.' })
    expect(read.messages.filter((message) => message.role === 'tool')).toHaveLength(3)
  }, 30_000)

  it('has nothing to read before the agent ever sent', async () => {
    await expect(bridgeOn('S4', stateDir()).bridge.read('agent-session-1', {})).rejects.toMatchObject({ code: 'unknown-conversation' })
  })
})

describe('hermes_send when Hermes asks for approval (S10)', () => {
  it('returns awaiting_approval with the request\'s own words, and never answers it', async () => {
    const { bridge, dials } = bridgeOn('S10', stateDir())
    const result = await bridge.send('agent-session-2', 'Clean temp files', { text: '[[hh:approval]] Delete it.', timeoutSeconds: 20 })

    expect(result).toMatchObject({
      status: 'awaiting_approval',
      conversationId: '20261014_092358_ad9451',
      request: { kind: 'approval', description: 'delete in root path: rm -r /tmp/hh-approval-probe-dir-does-not-exist' },
    })
    // Pending for the owner: the bridge neither approved nor declined.
    expect(dials[0]!.sent.some((frame) => frame.method === 'request.answer')).toBe(false)
    expect(dials[0]!.sent.some((frame) => frame.id === undefined && 'error' in frame)).toBe(false)
  }, 30_000)
})

describe('which Hermes', () => {
  it('refuses to guess between two signed-in servers', async () => {
    const bridge = new HermesAgentBridge({
      connections: { list: () => [CONNECTION, { ...CONNECTION, id: 'conn-2', name: 'Work' }], dialFor: () => async () => new FakeSocket(), restFor: () => { throw new Error() }, defaultLaneKey: async () => null },
      stateDir: stateDir(),
    })
    await expect(bridge.send('s', 't', { text: 'hi' })).rejects.toMatchObject({ code: 'ambiguous-connection' })
  })

  it('says to sign in when no connection is signed in', async () => {
    const bridge = new HermesAgentBridge({
      connections: { list: () => [{ ...CONNECTION, state: 'signed-out' }], dialFor: () => async () => new FakeSocket(), restFor: () => { throw new Error() }, defaultLaneKey: async () => null },
      stateDir: stateDir(),
    })
    await expect(bridge.send('s', 't', { text: 'hi' })).rejects.toMatchObject({ code: 'not-signed-in' })
  })
})
