import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop.js'
import { GoalLoopStore } from './GoalLoopStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))) })
async function makeStore(): Promise<{ store: GoalLoopStore; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  const file = join(directory, 'goal-loop.json')
  return { store: new GoalLoopStore(file), file }
}
// Set-aside copies are digest-named beside the file (never the whole-file
// `.corrupt` name, which a copy must not replace).
async function preservedCopies(file: string): Promise<string[]> {
  const names = (await readdir(dirname(file))).filter(name => name.startsWith('goal-loop.json.invalid-'))
  return Promise.all(names.map(name => readFile(join(dirname(file), name), 'utf8')))
}
const loop = (overrides: Partial<GoalLoopState> = {}): GoalLoopState => ({
  sessionId: 's1', goal: 'Ship it.', loopPrompt: 'Keep shipping.', phase: 'active',
  pauseReason: null, endReason: null, completionSummary: null,
  maxContinuations: 25, continuationsDelivered: 0, consecutiveDeliveryFailures: 0,
  startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
  ...overrides,
})

describe('GoalLoopStore', () => {
  it('round-trips states atomically and restores them after restart', async () => {
    const { store, file } = await makeStore()
    await store.write({ s1: loop() })
    const restored = await new GoalLoopStore(file).read()
    expect(restored['s1']).toEqual(loop())
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
  })
  it('returns an empty map for a missing file', async () => {
    const { store } = await makeStore()
    expect(await store.read()).toEqual({})
  })
  it('moves malformed storage aside instead of leaving it to be overwritten', async () => {
    // The bytes must survive the WRITE that follows a failed read: the
    // service starts empty and rewrites the whole document straight away, so
    // "still at the original path after read()" protected nothing.
    const { store, file } = await makeStore()
    await writeFile(file, '{broken')
    await expect(store.read()).rejects.toThrow()
    await store.write({ s1: loop() })
    expect(await readFile(store.quarantineFile, 'utf8')).toBe('{broken')
    expect((await store.read())['s1']).toEqual(loop())
  })
  it('sets a structurally invalid entry aside instead of reading it', async () => {
    const { store, file } = await makeStore()
    const source = JSON.stringify({ version: 1, loops: { s1: { phase: 'zooming' } } })
    await writeFile(file, source)
    expect(await store.read()).toEqual({})
    expect(await preservedCopies(file)).toEqual([source])
  })
})

// #1248: one loop this build cannot read (a newer build's phase, then a
// downgrade) used to move the WHOLE file aside; the service started empty and
// its next write made every other loop's loss permanent. Real loops from the
// owner's goal-loop.json (testing/fixtures/goal-loop, prompts redacted).
describe('one unreadable loop in a real store (#1248)', () => {
  const real = async () => (JSON.parse(await readFile(join(import.meta.dirname,
    '../../../testing/fixtures/goal-loop/real-loops-2026-09-25.json'), 'utf8')) as {
    document: { version: 1; loops: Record<string, GoalLoopState> }
  }).document

  it('keeps every other loop, preserves the original bytes, and survives the next write', async () => {
    const { store, file } = await makeStore()
    const document = await real()
    const [newer, kept] = Object.keys(document.loops)
    ;(document.loops[newer!] as { phase: string }).phase = 'waiting-on-review'
    const source = JSON.stringify(document)
    await writeFile(file, source)

    const loops = await store.read()
    expect(Object.keys(loops)).toEqual([kept])
    expect(loops[kept!]).toEqual(document.loops[kept!])
    // Copied, not moved: the file still holds the loops that were read.
    expect(await preservedCopies(file)).toEqual([source])
    expect(await readFile(file, 'utf8')).toBe(source)

    await store.write(loops)
    expect(Object.keys(await new GoalLoopStore(file).read())).toEqual([kept])
    expect(await preservedCopies(file)).toEqual([source])
  })

  it('counts only readable loops against the size limit', async () => {
    // 200 readable loops plus one this build cannot read: the unreadable one
    // must not push a trustworthy document over the limit and wipe it.
    const { store, file } = await makeStore()
    const loops: Record<string, unknown> = {}
    for (let index = 0; index < 200; index++) loops[`s${index}`] = loop({ sessionId: `s${index}`, phase: 'paused', pauseReason: 'user' })
    loops.newer = { ...loop({ sessionId: 'newer' }), phase: 'waiting-on-review' }
    await writeFile(file, JSON.stringify({ version: 1, loops }))
    expect(Object.keys(await store.read())).toHaveLength(200)
  })

  it('does not trust a partial copy a crash left under the final name', async () => {
    const { store, file } = await makeStore()
    const source = JSON.stringify({ version: 1, loops: { s1: loop(), newer: { ...loop({ sessionId: 'newer' }), phase: 'waiting-on-review' } } })
    await writeFile(file, source)
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
    await writeFile(join(dirname(file), `goal-loop.json.invalid-${digest}.json`), '')
    expect(Object.keys(await store.read())).toEqual(['s1'])
    expect(await preservedCopies(file)).toContain(source)
  })
})
