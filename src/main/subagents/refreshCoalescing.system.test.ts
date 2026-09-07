import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonlEntry, SubAgentState } from '@preload/api/types.js'
import { SubAgentWatcher } from './SubAgentWatcher.js'
import { CodexSubAgentTracker } from './codexSubagentState.js'

const reads = vi.hoisted(() => ({
  count: 0,
  active: 0,
  maxActive: 0,
  afterRead: null as null | (() => Promise<void>),
}))
// Resolve metadata operations through already-settled promises so every
// competing refresh reaches readRange without relying on filesystem timing.
// The fixtures and byte-range reader remain real; only scheduling is controlled.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const sync = await import('node:fs')
  return {
    ...original,
    readdir: async (path: string, options?: { withFileTypes: true }) => options ? sync.readdirSync(path, options) : sync.readdirSync(path),
    stat: async (path: string) => sync.statSync(path),
    readFile: async (path: string, encoding: BufferEncoding) => sync.readFileSync(path, encoding),
  }
})

vi.mock('./shared.js', async importOriginal => {
  const original = await importOriginal<typeof import('./shared.js')>()
  return {
    ...original,
    readRange: async (...args: Parameters<typeof original.readRange>) => {
      reads.count++
      reads.maxActive = Math.max(reads.maxActive, ++reads.active)
      const hook = reads.afterRead
      reads.afterRead = null
      try {
        const range = await original.readRange(...args)
        // Hold the old bytes AFTER the real range read. An append here must
        // be picked up by a trailing pass, not smuggled into the first read.
        await hook?.()
        return range
      } finally {
        reads.active--
      }
    },
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  Object.assign(reads, { count: 0, active: 0, maxActive: 0, afterRead: null })
})

async function fixture(provider: 'claude' | 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'subagent-refresh-'))
  const dir = join(root, 'sessions')
  await mkdir(dir)
  const file = join(dir, provider === 'claude' ? 'agent-child.jsonl' : 'rollout-child.jsonl')
  const emitted: Record<string, SubAgentState>[] = []
  let done = false
  const tracker = provider === 'claude'
    ? new SubAgentWatcher(dir, () => ({ done, error: false }), value => emitted.push(value))
    : new CodexSubAgentTracker(value => emitted.push(value))
  cleanups.push(async () => { tracker.stop(); await rm(root, { recursive: true, force: true }) })
  const parent = (entry: JsonlEntry) => {
    if (tracker instanceof CodexSubAgentTracker) tracker.observeParentEntry(entry, join(dir, 'parent.jsonl'))
  }
  await writeFile(join(dir, 'agent-child.meta.json'), JSON.stringify({ toolUseId: 'spawn' }))
  const line = (id: number) => JSON.stringify(provider === 'claude'
    ? { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Read', input: { file_path: `/synthetic-${id}` } }] } }
    : { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `synthetic-${id}` }] } }) + '\n'
  await writeFile(file, line(1))
  return {
    emitted, tracker, file, line,
    start() {
      if (tracker instanceof SubAgentWatcher) tracker.start()
      else parent({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn', output: JSON.stringify({ agent_id: 'child' }) } })
    },
    burst() {
      for (let i = 0; i < 50; i++) {
        if (tracker instanceof SubAgentWatcher) void tracker.refresh()
        else parent({ type: 'event_msg', payload: { type: 'token_count' } })
      }
    },
    complete() {
      done = true
      if (tracker instanceof SubAgentWatcher) void tracker.refresh()
      else parent({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<subagent_notification>\n{"agent_path":"child","status":"completed"}\n</subagent_notification>' }] } })
    },
  }
}

for (const provider of ['claude', 'codex'] as const) {
  describe(`${provider} serialized child refresh`, () => {
    it('folds one record once across 50 refresh triggers during the range read', async () => {
      const f = await fixture(provider)
      const entered = deferred(), release = deferred()
      reads.afterRead = async () => { entered.resolve(); await release.promise }
      f.start()
      await entered.promise
      f.burst()
      const drained = f.tracker.refresh()
      // The legacy paths need at most readdir/meta/stat continuations before
      // opening a duplicate range. Drain those microtasks while the first
      // range is held; this deterministically exposes duplicate ownership.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      release.resolve()
      await drained
      await vi.waitFor(() => {
        expect(reads.active).toBe(0)
        expect(f.emitted.length).toBeGreaterThan(0)
      })
      expect(reads.maxActive).toBe(1)
      expect(reads.count).toBe(1)
      expect(f.emitted.at(-1)?.spawn.turnCount).toBe(1)
      if (provider === 'claude') expect(f.emitted.at(-1)?.spawn.toolCalls).toHaveLength(1)
    })

    it('drains appended bytes and parent completion requested during I/O', async () => {
      const f = await fixture(provider)
      const entered = deferred(), release = deferred()
      reads.afterRead = async () => { entered.resolve(); await release.promise }
      f.start()
      await entered.promise
      await appendFile(f.file, f.line(2))
      f.burst()
      f.complete()
      const drained = f.tracker.refresh()
      release.resolve()
      await drained
      expect(reads.maxActive).toBe(1)
      expect(reads.count).toBe(2)
      expect(f.emitted.at(-1)?.spawn).toMatchObject({ turnCount: 2, status: 'done' })
    })

    it('cannot repopulate stopped state or emit after its blocked read finishes', async () => {
      const f = await fixture(provider)
      const entered = deferred(), release = deferred()
      reads.afterRead = async () => { entered.resolve(); await release.promise }
      f.start()
      await entered.promise
      const drained = f.tracker.refresh()
      f.tracker.stop()
      release.resolve()
      await drained
      f.burst()
      await f.tracker.refresh()
      expect(f.emitted).toEqual([])
      expect(reads.count).toBe(1)
      // Silence alone is not sufficient: the old outer stop guard still let
      // the reader pin an accumulator after stop had released all state.
      const retained = Reflect.get(f.tracker, provider === 'claude' ? 'accByAgent' : 'childAccByAgentId') as Map<unknown, unknown>
      expect(retained.size).toBe(0)
    })

    it('keeps a split UTF-8 JSONL record unread until its remaining bytes arrive', async () => {
      const f = await fixture(provider)
      f.start()
      await f.tracker.refresh()
      const bytes = Buffer.from(f.line(2).replace('synthetic-2', 'synthetic-🌱'))
      const split = bytes.indexOf(Buffer.from('🌱')) + 2
      await appendFile(f.file, bytes.subarray(0, split))
      await f.tracker.refresh()
      expect(f.emitted.at(-1)?.spawn.turnCount).toBe(1)
      await appendFile(f.file, bytes.subarray(split))
      f.burst()
      await f.tracker.refresh()
      expect(f.emitted.at(-1)?.spawn.turnCount).toBe(2)
      if (provider === 'claude') expect(f.emitted.at(-1)?.spawn.toolCalls.at(-1)?.headline).toBe('/synthetic-🌱')
    })

    it('retries a failed read on a requested trailing pass', async () => {
      const f = await fixture(provider)
      const entered = deferred(), release = deferred()
      reads.afterRead = async () => { entered.resolve(); await release.promise; throw new Error('synthetic transient read failure') }
      f.start()
      await entered.promise
      const drained = f.tracker.refresh()
      release.resolve()
      await drained
      expect(f.emitted.at(-1)?.spawn.turnCount).toBe(1)
      expect(reads.count).toBe(2)
    })
  })
}
