import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TranscriptMessage } from 'hermes-headless'
import { FakeSocket } from 'hermes-headless/testing/fakeSocket'
import { inboundFrames, latestRecording as recordingOf } from 'hermes-headless/testing/corpus'

import { HermesAgentBridge, redactSecrets, rowsForOurMessage } from './agentBridge.js'
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
      connections: { list: () => [CONNECTION, { ...CONNECTION, id: 'conn-2', name: 'Work' }], dialFor: () => async () => new FakeSocket(), restFor: () => { throw new Error() }, lookupLaneKey: async () => null } as never,
      stateDir: stateDir(),
    })
    await expect(bridge.send('s', 't', { text: 'hi' })).rejects.toMatchObject({ code: 'ambiguous-connection' })
  })

  it('says to sign in when no connection is signed in', async () => {
    const bridge = new HermesAgentBridge({
      connections: { list: () => [{ ...CONNECTION, state: 'signed-out' }], dialFor: () => async () => new FakeSocket(), restFor: () => { throw new Error() }, lookupLaneKey: async () => null } as never,
      stateDir: stateDir(),
    })
    await expect(bridge.send('s', 't', { text: 'hi' })).rejects.toMatchObject({ code: 'not-signed-in' })
  })
})

// ---------------------------------------------------------------------------
// Review round (#1516). Each test names the finding it pins.
// ---------------------------------------------------------------------------

describe('which rows answer OUR message (review B F1, recorded S20)', () => {
  // S20 sends four turns; Turn 4's submit came back `{"status":"queued"}`
  // with NO user_row_id. Stored rows: the recording's own two (row 1 user,
  // row 2 assistant) continued in the same shape with the recording's own
  // submitted texts and replies (a mechanical extension: the recorder never
  // re-read history after turn 1).
  const s20 = () => {
    const frames = inboundFrames(recordingOf('S20', { release: 'v0.22.0' }))
    const stored = frames.map((frame) => frame.result as { messages?: TranscriptMessage[] } | undefined).find((result) => Array.isArray(result?.messages) && result!.messages!.length > 0)!.messages!
    const sent = recordingOf('S20', { release: 'v0.22.0' }).filter((entry) => entry.dir === 'out' && entry.frame.method === 'prompt.submit').map((entry) => String((entry.frame.params as { text: string }).text))
    const reply = String(stored[1]!.text)
    const rows: TranscriptMessage[] = [...stored]
    sent.slice(1).forEach((text, index) => {
      rows.push({ role: 'user', text, row_id: 3 + index * 2 })
      rows.push({ role: 'assistant', text: `${reply} (${index + 2})`, row_id: 4 + index * 2 })
    })
    return { rows, sent }
  }

  it('a queued submit (no row id) is found by its text after the mark, and its answer stops at the next user row', () => {
    const { rows, sent } = s20()
    const queued = sent.at(-1)!
    const ours = rows.findIndex((row) => row.text === queued)
    // The mark is taken before the submit; the previous turn is still running.
    const mine = rowsForOurMessage(rows, { mark: ours - 2, userRowId: null, text: queued })
    expect(mine.found).toBe(true)
    expect(mine.after.map((row) => row.text)).toEqual([rows[ours + 1]!.text])
    // The PREVIOUS turn's answer (the old "everything after the mark") is not ours.
    expect(mine.after).not.toContainEqual(rows[ours - 1])
  })

  it('an accepted submit is found by its row id, and a later message bounds the answer', () => {
    const { rows } = s20()
    const mine = rowsForOurMessage(rows, { mark: 0, userRowId: 3, text: 'irrelevant' })
    expect(mine).toMatchObject({ found: true, closed: true })
    expect(mine.after).toHaveLength(1)
  })

  it('is not found before our row is committed', () => {
    const { rows, sent } = s20()
    expect(rowsForOurMessage(rows.slice(0, 2), { mark: 2, userRowId: null, text: sent.at(-1)! }).found).toBe(false)
  })
})

describe('the agent → conversation map', () => {
  it('two agents\' first sends at once both land, and the file stays valid JSON (review A F1)', async () => {
    const dir = stateDir()
    const { bridge } = bridgeOn('S4', dir, 0, { everyDialReplays: 'same' })
    await Promise.all([
      bridge.send('agent-a', 'A', { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 }),
      bridge.send('agent-b', 'B', { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 }),
    ])
    const map = JSON.parse(readFileSync(join(dir, 'hermes', 'agent-conversations.json'), 'utf8')) as Record<string, Record<string, string>>
    expect(Object.keys(map['conn-1']!).sort()).toEqual(['agent-a', 'agent-b'])
    expect(readdirSync(join(dir, 'hermes')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  }, 30_000)

  it('keeps a copy of a corrupt map instead of silently overwriting it (review A F5)', async () => {
    const dir = stateDir()
    mkdirSync(join(dir, 'hermes'), { recursive: true })
    writeFileSync(join(dir, 'hermes', 'agent-conversations.json'), '{"conn-1": {"agent-a": "20261014_092150_c02da4"', 'utf8')
    const { bridge } = bridgeOn('S4', dir)
    await expect(bridge.read('agent-a', {})).rejects.toMatchObject({ code: 'unknown-conversation' })
    expect(readdirSync(join(dir, 'hermes')).some((name) => name.startsWith('agent-conversations.json.corrupt-'))).toBe(true)
  })

  it('a deleted "own" conversation is forgotten and a send starts a new one, without a junk resume (review B F4)', async () => {
    const dir = stateDir()
    mkdirSync(join(dir, 'hermes'), { recursive: true })
    writeFileSync(join(dir, 'hermes', 'agent-conversations.json'), JSON.stringify({ 'conn-1': { 'agent-a': 'deleted_on_server' } }), 'utf8')
    const { bridge, dials } = bridgeOn('S4', dir)
    const result = await bridge.send('agent-a', 'A', { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 })
    expect(result).toMatchObject({ status: 'replied', conversationId: '20261014_092150_c02da4' })
    expect(dials[0]!.sent.some((frame) => frame.method === 'session.resume')).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'hermes', 'agent-conversations.json'), 'utf8'))['conn-1']['agent-a']).toBe('20261014_092150_c02da4')
  }, 30_000)
})

describe('an id Hermes does not have (reviews A F7, B F4)', () => {
  it('is refused before any socket opens, so no junk conversation is created', async () => {
    const { bridge, dials } = bridgeOn('S4', stateDir())
    await expect(bridge.read('agent-a', { conversation: 'typo_123' })).rejects.toMatchObject({ code: 'unknown-conversation' })
    await expect(bridge.send('agent-a', 'A', { text: 'hi', conversation: 'typo_123' })).rejects.toMatchObject({ code: 'unknown-conversation' })
    expect(dials).toHaveLength(0)
  })
})

describe('what an agent may see of Hermes\' tool calls (review A F3)', () => {
  it('scrubs credentials Hermes typed on the server', () => {
    expect(redactSecrets('terminal curl -H "Authorization: Bearer sk-live-abcdefghijklmnop" https://api.example')).not.toMatch(/abcdefghijklmnop/)
    expect(redactSecrets('terminal export OPENAI_API_KEY=sk-proj-1234567890abcdef && run')).toBe('terminal export OPENAI_API_KEY=[redacted] && run')
    expect(redactSecrets('terminal git push https://ghp_0123456789abcdefghijABCDEFGHIJ@github.com/x')).not.toMatch(/ghp_/)
    expect(redactSecrets('terminal ls -la /opt/data')).toBe('terminal ls -la /opt/data')
  })

  it('marks every message as sent by an agent (review A F4, UNCONFIRMED)', async () => {
    const { bridge, dials } = bridgeOn('S4', stateDir())
    await bridge.send('agent-a', 'Fix the flaky test', { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 })
    expect((dials[0]!.sent.find((frame) => frame.method === 'prompt.submit')!.params as { text: string }).text)
      .toBe('[Sent by an Agent Code agent: Fix the flaky test]\n\n[[hh:tools]] Run the tools.')
  }, 30_000)
})
