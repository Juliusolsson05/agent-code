import { appendFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubAgentState } from '@preload/api/types.js'
import { CODEX_CHILD_DISCOVERY_RETRY_MS, CodexSubAgentTracker } from './codexSubagentState.js'

const io = vi.hoisted(() => ({ readdir: 0, stat: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => { io.readdir++; return actual.readdir(...args) },
    stat: (...args: Parameters<typeof actual.stat>) => { io.stat++; return actual.stat(...args) },
  }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  io.readdir = io.stat = 0
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-discovery-'))
  const sessions = join(root, 'sessions')
  await mkdir(sessions)
  let clock = 1000
  const emitted: Record<string, SubAgentState>[] = []
  const tracker = new CodexSubAgentTracker(state => emitted.push(state), () => clock)
  cleanups.push(async () => { tracker.stop(); await rm(root, { recursive: true, force: true }) })
  const parent = join(sessions, 'parent.jsonl')
  return {
    root, sessions, tracker, emitted,
    advance: (ms: number) => { clock += ms },
    child(id: string) {
      tracker.observeParentEntry({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ agent_id: id }) } }, parent)
    },
    unrelated() { tracker.observeParentEntry({ type: 'event_msg', payload: { type: 'token_count' } }, parent) },
  }
}
function line(text: string) {
  return JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n'
}

describe('bounded missing Codex child discovery', () => {
  it('shares one scan across missing children and ignores 1,000 unrelated records in the retry window', async () => {
    const f = await fixture()
    for (let d = 0; d < 10; d++) {
      const dir = join(f.sessions, String(d))
      await mkdir(dir)
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, `unrelated-${i}.jsonl`), '')))
    }
    f.child('missing-a'); f.child('missing-b'); f.child('missing-c')
    await f.tracker.refresh()
    expect(io).toEqual({ readdir: 11, stat: 0 })
    for (let i = 0; i < 1000; i++) f.unrelated()
    // Explicit sequential refreshes protect against merely hiding the work
    // behind #802 coalescing: a quiet missing child must keep its negative TTL.
    await f.tracker.refresh(); await f.tracker.refresh(); await f.tracker.refresh()
    expect(io).toEqual({ readdir: 11, stat: 0 })
    f.child('missing-d')
    await f.tracker.refresh()
    expect(io.readdir).toBe(11) // New ids cannot bypass the scan budget.
  })

  it('finds a child created after a miss and keeps tailing it during the discovery cooldown', async () => {
    const f = await fixture()
    f.child('late-child')
    await f.tracker.refresh()
    const file = join(f.sessions, 'rollout-late-child.jsonl')
    await writeFile(file, line('first'))
    f.advance(CODEX_CHILD_DISCOVERY_RETRY_MS - 1)
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['late-child'].turnCount).toBe(0)
    f.advance(1)
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['late-child'].turnCount).toBe(1)
    const scanned = io.readdir
    await appendFile(file, line('second'))
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['late-child'].turnCount).toBe(2)
    expect(io.readdir).toBe(scanned)
  })

  it('does not follow symlink cycles or linked foreign rollouts', async () => {
    const f = await fixture()
    await symlink(f.sessions, join(f.sessions, 'cycle'))
    const foreign = join(f.root, 'foreign.jsonl')
    await writeFile(foreign, line('not this archive'))
    await symlink(foreign, join(f.sessions, 'rollout-linked-child.jsonl'))
    f.child('linked-child')
    await f.tracker.refresh()
    expect(io).toEqual({ readdir: 1, stat: 0 })
    expect(f.emitted.at(-1)?.['linked-child'].turnCount).toBe(0)
  })

  it('resets cached paths and offsets when a parent moves to another sessions root', async () => {
    const f = await fixture()
    await writeFile(join(f.sessions, 'rollout-child-a.jsonl'), line('old one') + line('old two'))
    f.child('child-a')
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['child-a'].turnCount).toBe(2)
    const next = join(f.root, 'another', 'sessions')
    await mkdir(next, { recursive: true })
    await writeFile(join(next, 'rollout-child-a.jsonl'), line('new archive'))
    f.tracker.observeParentEntry({ type: 'event_msg', payload: { type: 'token_count' } }, join(next, 'parent.jsonl'))
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['child-a'].turnCount).toBe(1)
  })

  it('keeps later children progressing after a cached file vanishes, then rediscovers it', async () => {
    const f = await fixture()
    const a = join(f.sessions, 'rollout-child-a.jsonl'), b = join(f.sessions, 'rollout-child-b.jsonl')
    await writeFile(a, line('a')); await writeFile(b, line('b'))
    f.child('child-a'); f.child('child-b')
    await f.tracker.refresh()
    await unlink(a); await appendFile(b, line('still running'))
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['child-b'].turnCount).toBe(2)
    await writeFile(join(f.sessions, 'replacement-child-a.jsonl'), line('replacement'))
    f.advance(CODEX_CHILD_DISCOVERY_RETRY_MS)
    await f.tracker.refresh()
    expect(f.emitted.at(-1)?.['child-a'].turnCount).toBe(1)
  })
})
