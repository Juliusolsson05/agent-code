import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  it('preserves malformed storage instead of resetting it', async () => {
    const { store, file } = await makeStore()
    await writeFile(file, '{broken')
    await expect(store.read()).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
  it('rejects structurally invalid entries', async () => {
    const { store, file } = await makeStore()
    await writeFile(file, JSON.stringify({ version: 1, loops: { s1: { phase: 'zooming' } } }))
    await expect(store.read()).rejects.toThrow()
  })
})
