import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The grok session-feed recordings (decomposition plan Stage 5): wire-form
// captures of the app's OWN delivery behavior around a durable-history
// rewrite, produced by the REAL forwarder and its coalescers — not sketches.
//
// WHY this shape and not a live app recording: the plan demands "actual
// post-batch/transport/store behavior", and the thing under test is the APP's
// ordering, not native's (native behavior is pinned by the headless package's
// 52-timeline corpus). So the SCRIPT below is the session-level event sequence
// a recorded rewrite produces (modeled on the corpus's text-load-repeat
// generation-1 rewrite: pre-rewrite rows, the turn's completion, the reset,
// the re-delivered snapshot, caught-up, then appended rows), and the RECORDING
// is whatever the real wireSessionForwarder emits for it — coalescer batching,
// the flush-before-boundary discipline and all. Regenerate with
// GROK_SESSION_FEED_REGEN=1; the checked-in fixture must match byte-for-byte
// otherwise (fixture content is fully deterministic).

const wire = vi.hoisted(() => ({ receive: (_channel: string, _payload: unknown) => {} }))

// Same seam forwarder.test.ts uses: the forwarder imports sendToSessionWindow
// from windowRegistry, and the mock lets this test capture the exact wire
// frames instead of touching real windows.
vi.mock('@main/window/windowRegistry.js', () => ({
  broadcastToWindows: () => {},
  releaseSession: () => {},
  sendToSessionWindow: (_id: string, channel: string, payload: unknown) => wire.receive(channel, payload),
}))

const { wireSessionForwarder } = await import('@main/sessions/forwarder.js')

const fixtures = new URL('../../../../testing/fixtures/grok-session-feed/', import.meta.url)
const fixturePath = new URL('rewrite-reorder.events.jsonl', fixtures).pathname

const sessionId = 'grok-feed-1'
const file = '/tmp/grok-home/sessions/grok-feed-1/chat_history.jsonl'

type ManagerEvent = [event: string, payload: unknown]

/** The session-level script of a recorded rewrite (see the file header). */
function rewriteScript(): ManagerEvent[] {
  const entry = (item: unknown, generation: number, offset: number, inRewriteSnapshot = false) => ({
    sessionId,
    // The wire entry is the headless package's durable record; the renderer's
    // grok mapper derives stable uuids from (generation, offset). Snapshot
    // rows carry inRewriteSnapshot exactly as HistoryReader would mark them
    // (inside the generation's rewrite snapshot), and genuine user rows carry
    // the corpus's <user_query>-wrapped shape with prompt_index.
    entry: { sessionId, item, raw: JSON.stringify(item), generation, lineStartOffset: offset, inRewriteSnapshot },
    file,
  })
  const userQuery = (text: string, promptIndex: number) => ({
    type: 'user',
    content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }],
    prompt_index: promptIndex,
  })
  const boundary = (type: 'reset' | 'caught-up', generation: number) => ({
    sessionId, type, generation, snapshotByteLength: 400, ...(type === 'caught-up' ? { byteOffset: 400, complete: true } : {}), file,
  })
  return [
    // Pre-rewrite generation 0: the committed conversation...
    ['jsonl-entry', entry(userQuery('hello', 0), 0, 10)],
    ['jsonl-entry', entry({ type: 'assistant', content: 'old answer' }, 0, 95)],
    // ...and the turn's own completion still sitting in the 100 ms semantic
    // window when the rewrite lands — the boundary must flush it FIRST.
    ['semantic-event', { sessionId, event: { type: 'turn_completed', turnId: 'prompt-1', fullText: 'old answer', stopReason: 'end_turn', source: 'grok-acp', confidence: 'high', ts: 1 } }],
    // The rewrite: generation 1's snapshot (400 bytes) re-delivers the same
    // CONTENT inside the snapshot (inRewriteSnapshot: true — the mapper keeps
    // the rows, the boundary wiped the window), then caught-up, then a
    // genuinely new row APPENDED past the snapshot's declared end.
    ['history-boundary', boundary('reset', 1)],
    ['jsonl-entry', entry(userQuery('hello', 0), 1, 10, true)],
    ['jsonl-entry', entry({ type: 'assistant', content: 'old answer' }, 1, 95, true)],
    ['history-boundary', boundary('caught-up', 1)],
    ['jsonl-entry', entry({ type: 'assistant', content: 'new answer' }, 1, 420)],
    ['process-state', { sessionId, active: false }],
    // A late duplicate reset (reconnect re-delivery) and its caught-up: the
    // reset is stale against the window's generation; the caught-up is a
    // no-op observe for a window no longer awaiting one. Both still CROSS —
    // transports order, they do not interpret.
    ["history-boundary", boundary("reset", 1)],
    ["history-boundary", boundary("caught-up", 1)],
  ]
}

async function captureWireFrames(script: ManagerEvent[]): Promise<Array<{ channel: string; payload: unknown }>> {
  const frames: Array<{ channel: string; payload: unknown }> = []
  wire.receive = (channel, payload) => { frames.push({ channel, payload }) }
  const manager = new EventEmitter()
  const forwarder = wireSessionForwarder(manager as never, new EventEmitter() as never)
  try {
    for (const [event, payload] of script) manager.emit(event, payload)
    // The jsonl coalescer flushes on setImmediate; give the microtask queue a
    // full macrotask turn so batching settles before capture stops.
    await new Promise(resolve => setImmediate(resolve))
    forwarder.flush()
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    wire.receive = () => {}
    forwarder.flush()
  }
  return frames
}

describe('grok session-feed recordings (Stage 5)', () => {
  beforeEach(() => { wire.receive = () => {} })
  afterEach(() => { vi.restoreAllMocks() })

  it('records the wire form through the real forwarder and matches the checked-in fixture', async () => {
    const frames = await captureWireFrames(rewriteScript())
    expect(frames.length).toBeGreaterThan(0)
    const serialized = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'
    if (process.env.GROK_SESSION_FEED_REGEN === '1') {
      if (!existsSync(fixtures.pathname)) mkdirSync(fixtures.pathname, { recursive: true })
      writeFileSync(fixturePath, serialized)
      writeFileSync(join(fixtures.pathname, 'rewrite-reorder.meta.json'), JSON.stringify({
        scenario: 'rewrite-reorder',
        source: 'session-level script modeled on the grok corpus text-load-repeat generation-1 rewrite; frames captured through the real wireSessionForwarder',
        channels: [...new Set(frames.map(frame => frame.channel))],
      }, null, 2) + '\n')
      return
    }
    expect(existsSync(fixturePath), 'fixture exists (run with GROK_SESSION_FEED_REGEN=1 once)').toBe(true)
    expect(serialized).toBe(readFileSync(fixturePath, 'utf8'))
  })

  it('pins the ordering discipline: superseded entries and the semantic preview land BEFORE the boundary, which is never coalesced', async () => {
    const frames = await captureWireFrames(rewriteScript())
    const channels = frames.map(frame => frame.channel)
    // The two pre-rewrite entries arrive as one bulk frame (the semantic
    // completion is its own flushed frame), then the boundary.
    const bulkIndex = channels.indexOf('session:jsonl-entries')
    const boundaryIndex = channels.indexOf('session:history-boundary')
    expect(bulkIndex).toBeGreaterThanOrEqual(0)
    expect(boundaryIndex).toBeGreaterThan(bulkIndex)
    // The semantic window flushed ahead of the boundary, not after it.
    const semanticIndex = channels.indexOf('session:semantic-event')
    expect(semanticIndex).toBeGreaterThanOrEqual(0)
    expect(semanticIndex).toBeLessThan(boundaryIndex)
    // Exactly one boundary frame per emitted boundary (reset, caught-up, and
    // the two stale reconnect re-deliveries) — never coalesced away.
    expect(channels.filter(channel => channel === 'session:history-boundary')).toHaveLength(4)
  })

})
