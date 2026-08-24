import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// SESSION_RECORDING_DIR is resolved from STATE_DIR at import time, so point
// STATE_DIR's root at a temp dir BEFORE importing the recorder. The path
// module reads homedir()/.config/<slug>; we can't easily reroute that, so
// instead we mock the paths module.
const TMP = mkdtempSync(join(tmpdir(), 'rec-test-'))

vi.mock('@main/storage/paths.js', () => ({
  SESSION_RECORDING_DIR: TMP,
}))
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

const { SessionRecorderManager } = await import('./SessionRecorderManager.js')

// Deterministic clocks so `t`/`wall` are assertable and monotonic advances
// on demand.
let mono = 0
let wall = 1_700_000_000_000
const nowMono = () => mono
const nowWall = () => wall

function mgr(): InstanceType<typeof SessionRecorderManager> {
  return new SessionRecorderManager(nowWall, nowMono)
}

// TMP is shared across tests, so select the recording folder by its
// sessionId suffix (recordingId is `<iso>-<sessionId>`) instead of "last
// folder", which would race with other tests' recordings. Polls because
// meta.json is written eagerly-but-async on recorder construction (the
// folder appears "very soon", not synchronously with the first event).
async function readRecordingDir(sessionId: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const dirs = readdirSync(TMP).filter(
      d => d.endsWith(`-${sessionId}`) && existsSync(join(TMP, d, 'meta.json')),
    )
    if (dirs.length > 0) return join(TMP, dirs[dirs.length - 1])
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`no recording folder for ${sessionId}`)
}

beforeEach(() => {
  mono = 0
  wall = 1_700_000_000_000
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('SessionRecorderManager', () => {
  it('records only allowlisted channels, keyed by sessionId, into a per-recording folder', async () => {
    const m = mgr()
    m.startRecording('s1') // command-driven: record only after explicit start
    // Non-allowlisted channels and PTY channels are ignored.
    m.observe('lsp:diagnostics', [{ sessionId: 's1' }])
    m.observe('session:terminal-data', [{ sessionId: 's1', data: 'raw pty' }])
    // Allowlisted.
    mono = 10
    m.observe('session:semantic-event', [{ sessionId: 's1', event: { kind: 'turn_started' } }])
    mono = 18
    m.observe('session:transcript-diagnostic', [{
      sessionId: 's1',
      diagnostic: {
        type: 'fresh-rollout-ownership-decision',
        decision: 'hold',
        tailStarted: false,
      },
    }])
    mono = 25
    m.observe('session:jsonl-entries', [
      { sessionId: 's1', entries: [{ uuid: 'u1' }], file: '/x.jsonl' },
    ])
    await m.stop('s1')

    const dir = await readRecordingDir('s1')
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    expect(meta.sessionId).toBe('s1')
    expect(meta.eventCount).toBe(3) // the three allowlisted, not the pty/lsp
    expect(meta.endedAtWall).toBe(wall)

    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(lines.map(l => l.ch)).toEqual([
      'session:semantic-event',
      'session:transcript-diagnostic',
      'session:jsonl-entries',
    ])
    // t is relative to recording START (explicit startRecording at mono=0),
    // so adding a diagnostic must preserve the original event timestamps and
    // occupy its own measured point rather than inheriting the next feed event.
    expect(lines[0].t).toBe(10)
    expect(lines[1].t).toBe(18)
    expect(lines[2].t).toBe(25)
    expect(lines[0].payload.event.kind).toBe('turn_started')
    expect(lines[1].payload.diagnostic).toMatchObject({
      decision: 'hold',
      tailStarted: false,
    })
  })

  it('defers payload serialization off the outbound IPC observation stack', async () => {
    const m = mgr()
    m.startRecording('deferred')
    const toJSON = vi.fn(() => ({ safely: 'serialized later' }))

    m.observe('session:semantic-event', [
      {
        sessionId: 'deferred',
        event: { type: 'tool_input_delta', payload: { toJSON } },
      },
    ])

    // The observer is invoked synchronously after BrowserWindow.send. Calling
    // user JSON hooks here proves serialization is still on that critical path.
    expect(toJSON).not.toHaveBeenCalled()
    await m.stop('deferred')
    expect(toJSON).toHaveBeenCalledTimes(1)
  })

  it('ignores payloads without a sessionId', async () => {
    const m = mgr()
    m.observe('session:screen', [{ screen: 'no id here' }])
    expect(m.isRecording('anything')).toBe(false)
  })

  it('keeps the recorder open on session:exit until the renderer finishes its shape flush', async () => {
    const stopping = vi.fn()
    const m = new SessionRecorderManager(nowWall, nowMono, false, () => {}, stopping)
    m.startRecording('s2', { kind: 'claude' }) // command passes provider hint
    m.observe('session:started', [{ sessionId: 's2', kind: 'claude' }])
    expect(m.isRecording('s2')).toBe(true)
    m.observe('session:exit', [{ sessionId: 's2', code: 0 }])
    const generation = stopping.mock.calls[0]?.[1]
    expect(stopping).toHaveBeenCalledWith('s2', expect.any(String))
    expect(m.isRecording('s2')).toBe(true)
    expect(m.appendRenderShapes('s2', generation, [{ structuralFingerprint: 'fp2-deadbeef' }])).toBe(true)
    await m.finishStopping('s2', generation)
    expect(m.isRecording('s2')).toBe(false)
    const dir = await readRecordingDir('s2')
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    expect(meta.provider).toBe('claude')
  })

  it('cannot apply a late acknowledgement or timer to a reused sessionId generation', async () => {
    const stopping = vi.fn()
    const m = new SessionRecorderManager(nowWall, nowMono, false, () => {}, stopping)

    m.startRecording('reused')
    m.observe('session:exit', [{ sessionId: 'reused', code: 0 }])
    const oldGeneration = stopping.mock.calls[0]?.[1]
    expect(oldGeneration).toEqual(expect.any(String))

    // A provider can reuse a logical id before the old generation's grace
    // timer expires. The fresh start itself must detach the stopping recorder,
    // create a distinct folder even when Date.now() has not advanced, and keep
    // the old flush reply addressed only to the recorder that issued it.
    m.startRecording('reused')
    const newGeneration = m.recordingGeneration('reused')
    expect(newGeneration).toEqual(expect.any(String))
    expect(newGeneration).not.toBe(oldGeneration)
    if (!newGeneration) throw new Error('replacement recorder did not expose its generation')
    // The generation is both an append fence and a grace-period address. A's
    // delayed final batch must still reach A, never B, while B is already the
    // active ordinary-event recorder for the reused logical session id.
    expect(m.appendRenderShapes('reused', oldGeneration, [{ structuralFingerprint: 'old' }])).toBe(true)
    expect(m.appendRenderShapes('reused', newGeneration, [{ structuralFingerprint: 'new' }])).toBe(true)
    await m.finishStopping('reused', oldGeneration)
    expect(m.isRecording('reused')).toBe(true)
    expect(m.appendRenderShapes('reused', oldGeneration, [{ structuralFingerprint: 'too-late' }])).toBe(false)

    // requestStop's timer captures this same (sessionId, generation) pair and
    // delegates to stopGeneration. Call that endpoint directly instead of
    // sleeping three seconds: the assertion is specifically that its identity
    // guard, not clearTimeout timing, protects the replacement recorder.
    await (
      m as unknown as {
        stopGeneration(sessionId: string, generation: string): Promise<void>
      }
    ).stopGeneration('reused', oldGeneration)
    expect(m.isRecording('reused')).toBe(true)

    // The pre-generation API is intentionally fail-safe as well. It cannot
    // prove which reused session it means, so the bounded timer owns closure.
    await m.finishStopping('reused')
    expect(m.isRecording('reused')).toBe(true)
    await m.stopRecording('reused')

    const dirs = readdirSync(TMP).filter(d => d.endsWith('-reused'))
    expect(new Set(dirs).size).toBe(2)
    const shapeFingerprints = dirs.map(dir =>
      readFileSync(join(TMP, dir, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(line => line.ch === '__render_shape')
        .flatMap(line => line.sightings.map((sighting: { structuralFingerprint: string }) =>
          sighting.structuralFingerprint,
        )),
    )
    expect(shapeFingerprints).toContainEqual(['old'])
    expect(shapeFingerprints).toContainEqual(['new'])
  })

  it('captures reserve-then-fill notes as __note lines', async () => {
    const m = mgr()
    m.startRecording('s3')
    m.observe('session:started', [{ sessionId: 's3', kind: 'codex' }])
    mono = 5
    const noteId = m.reserveNote('s3')
    expect(noteId).not.toBeNull()
    mono = 40
    m.fillNote('s3', noteId!, 'reads vanished right here')
    await m.stop('s3')

    const dir = await readRecordingDir('s3')
    const notes = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
      .filter(l => l.ch === '__note')
    expect(notes.map(n => n.note.status)).toEqual(['reserved', 'filled'])
    expect(notes[0].note.id).toBe(noteId)
    expect(notes[1].note.text).toBe('reads vanished right here')
    // The reserved marker was written at the reaction tick (t=5), not the
    // fill tick (t=40) — the whole point of reserve-first.
    expect(notes[0].t).toBe(5)
  })

  it('reserveNote returns null when no recording is active for the session', () => {
    const m = mgr()
    expect(m.reserveNote('never-started')).toBeNull()
  })

  it('flushAll finalizes every open recording', async () => {
    const m = mgr()
    m.startRecording('a')
    m.startRecording('b')
    await m.flushAll()
    expect(m.isRecording('a')).toBe(false)
    expect(m.isRecording('b')).toBe(false)
  })

  it('does NOT record until a session is explicitly started (default: autoRecord off)', async () => {
    const m = mgr() // autoRecord defaults false
    m.observe('session:started', [{ sessionId: 'nope', kind: 'claude' }])
    m.observe('session:semantic-event', [{ sessionId: 'nope', event: {} }])
    // No recorder was created, nothing on disk for this session.
    expect(m.isRecording('nope')).toBe(false)
  })

  it('records a session once startRecording is called, and stops on stopRecording', async () => {
    const m = mgr()
    m.startRecording('go')
    expect(m.isRecording('go')).toBe(true)
    mono = 10
    m.observe('session:semantic-event', [{ sessionId: 'go', event: { kind: 'turn_started' } }])
    await m.stopRecording('go')
    expect(m.isRecording('go')).toBe(false)
    const dir = await readRecordingDir('go')
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(lines.some(l => l.ch === 'session:semantic-event')).toBe(true)
  })

  it('auto-records every session ONLY when autoRecord is on (the power flag)', async () => {
    const m = new SessionRecorderManager(nowWall, nowMono, true)
    m.observe('session:started', [{ sessionId: 'auto', kind: 'codex' }])
    expect(m.isRecording('auto')).toBe(true)
    await m.stopRecording('auto')
  })
})
