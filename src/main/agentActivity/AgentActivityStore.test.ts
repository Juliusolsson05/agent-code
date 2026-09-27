import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentActivityStore } from '@main/agentActivity/AgentActivityStore.js'
import type { ActivityContext } from '@main/agentActivity/AgentActivityStore.js'

// The history is kept forever (#964 §6 Q8), so these pin the two properties that
// keep it small and correct: context written once per month, and a crash never
// turning into hours of work that did not happen.

const HOUR = 3_600_000
const SECOND = 1_000
const context: ActivityContext = {
  agentKey: 'ada',
  label: 'Ada',
  role: 'user',
  provider: 'claude',
  tabId: 'tab-1',
  tabTitle: 'agent-code',
  repoRoot: '/dev/agent-code',
  cwd: '/dev/agent-code',
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-activity-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const lines = async (name: string): Promise<string[]> =>
  (await readFile(join(dir, name), 'utf8')).split('\n').filter(Boolean)

describe('AgentActivityStore', () => {
  it("writes an agent's context once per month and reads every interval overlapping a range, including one filed under the previous month", async () => {
    const store = new AgentActivityStore(dir)
    const acrossMonths = { startedAt: Date.parse('2026-08-31T23:30:00Z'), endedAt: Date.parse('2026-09-01T00:30:00Z') }
    await store.appendInterval({ context, ...acrossMonths })
    await store.appendInterval({ context, startedAt: Date.parse('2026-09-01T10:00:00Z'), endedAt: Date.parse('2026-09-01T11:00:00Z') })
    await store.appendInterval({ context, startedAt: Date.parse('2026-09-01T12:00:00Z'), endedAt: Date.parse('2026-09-01T13:00:00Z') })

    expect((await lines('2026-09.jsonl')).filter(line => line.includes('"t":"c"'))).toHaveLength(1)
    expect(await lines('2026-09.jsonl')).toHaveLength(3)

    const read = await store.readIntervals(Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-09-01T12:00:00Z'))
    expect(read.map(interval => interval.startedAt)).toEqual([acrossMonths.startedAt, Date.parse('2026-09-01T10:00:00Z')])
    expect(read[0].context).toEqual(context)
    expect(await store.firstRecordedAt()).toBe(acrossMonths.startedAt)
  })

  it('reuses a context already in the file after a restart instead of writing it again', async () => {
    const start = Date.parse('2026-09-01T10:00:00Z')
    await new AgentActivityStore(dir).appendInterval({ context, startedAt: start, endedAt: start + HOUR })
    const restarted = new AgentActivityStore(dir)
    await restarted.appendInterval({ context, startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR })

    expect((await lines('2026-09.jsonl')).filter(line => line.includes('"t":"c"'))).toHaveLength(1)
    expect(await restarted.readIntervals(start, start + 4 * HOUR)).toHaveLength(2)
  })

  it('skips a line torn by a crash mid-append', async () => {
    const store = new AgentActivityStore(dir)
    const start = Date.parse('2026-09-01T10:00:00Z')
    await store.appendInterval({ context, startedAt: start, endedAt: start + HOUR })
    await appendFile(join(dir, '2026-09.jsonl'), '{"t":"i","c":1,"s":')

    expect(await store.readIntervals(start, start + HOUR)).toHaveLength(1)
  })

  it("closes intervals a crashed run left open at that run's last touch, exactly once", async () => {
    const start = Date.parse('2026-09-01T22:00:00Z')
    const lastTouch = start + 30 * SECOND
    await new AgentActivityStore(dir).writeOpen([{ sessionId: 'session-1', context, startedAt: start }], lastTouch)

    const nextLaunch = new AgentActivityStore(dir)
    expect(await nextLaunch.recoverOpenIntervals(start + 10 * HOUR)).toBe(1)
    expect(await nextLaunch.recoverOpenIntervals(start + 11 * HOUR)).toBe(0)
    expect(await nextLaunch.readIntervals(start, start + 12 * HOUR)).toEqual([{ context, startedAt: start, endedAt: lastTouch }])
  })

  it('keeps machine suspensions and ignores malformed ones', async () => {
    const store = new AgentActivityStore(dir)
    await store.appendSuspension({ suspendedAt: 100, resumedAt: 500, source: 'power-monitor' })
    await appendFile(join(dir, 'suspensions.jsonl'), '{"s":900,"r":800}\n')

    expect(await store.readSuspensions()).toEqual([{ suspendedAt: 100, resumedAt: 500 }])
  })

  // #1342 verification b and c: a crash can leave a torn last line. The next
  // append used to continue it, and the reader then dropped the torn bytes
  // AND the first new record as one bad line.
  it('keeps the first alias appended after a torn last line', async () => {
    await appendFile(join(dir, 'aliases.jsonl'), '{"f":"torn","t":')
    await new AgentActivityStore(dir).appendAliases([['old-session', 'stable-identity']])
    const store = new AgentActivityStore(dir)
    await store.appendInterval({ context: { ...context, agentKey: 'old-session' }, startedAt: 0, endedAt: HOUR })
    await store.appendInterval({ context: { ...context, agentKey: 'stable-identity' }, startedAt: HOUR, endedAt: 2 * HOUR })
    const keys = new Set((await new AgentActivityStore(dir).readIntervals(0, 3 * HOUR)).map(interval => interval.context.agentKey))
    expect(keys.size).toBe(1)
  })

  it('keeps the first interval appended after a torn last line', async () => {
    const start = Date.parse('2026-09-10T09:00:00Z')
    await appendFile(join(dir, '2026-09.jsonl'), '{"t":"i","c":1,"s":')
    await new AgentActivityStore(dir).appendInterval({ context, startedAt: start, endedAt: start + HOUR })
    expect(await new AgentActivityStore(dir).readIntervals(start, start + 2 * HOUR)).toHaveLength(1)
  })

  // Edges can point both ways (a name given after an identity); every key an
  // edge connects is one agent, whichever key a row was written under.
  it('groups keys joined by aliases in either direction, cycles included', async () => {
    const store = new AgentActivityStore(dir)
    await store.appendAliases([['child', 'tldr-x']])
    await store.appendAliases([['tldr-x', 'child']])
    await store.appendInterval({ context: { ...context, agentKey: 'child' }, startedAt: 0, endedAt: HOUR })
    await store.appendInterval({ context: { ...context, agentKey: 'tldr-x' }, startedAt: HOUR, endedAt: 2 * HOUR })
    const keys = new Set((await new AgentActivityStore(dir).readIntervals(0, 3 * HOUR)).map(interval => interval.context.agentKey))
    expect(keys.size).toBe(1)
  })
})

// #1303: the context id was cached BEFORE its context line was written. One
// failed append (ENOSPC, EIO) then left every later interval for that agent
// this month pointing at a context line that never reached disk, and
// readIntervals dropped each one silently.
describe('a failed context write', () => {
  it('does not orphan the agent\'s later intervals', async () => {
    const store = new AgentActivityStore(dir)
    const internal = store as unknown as { appendLines: (file: string, lines: string[]) => Promise<void> }
    const realAppend = internal.appendLines.bind(store)
    let failNext = true
    internal.appendLines = async (file, lines) => {
      if (failNext) { failNext = false; throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }) }
      return realAppend(file, lines)
    }
    const start = Date.parse('2026-09-01T09:00:00Z')
    await expect(store.appendInterval({ context, startedAt: start, endedAt: start + HOUR })).rejects.toThrow('no space left')
    await store.appendInterval({ context, startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR })
    const read = await new AgentActivityStore(dir).readIntervals(start, start + 4 * HOUR)
    expect(read.map(interval => interval.startedAt)).toEqual([start + 2 * HOUR])
  })
})

// #1414 review a+b: a PARTIAL write (A's context line lands, then the append
// fails before its interval line) left id 1 on disk for A. A was not cached, so
// B's next context also took id 1; after a restart a later A interval reused
// id 1 and read back as B's time.
describe('a partially written context', () => {
  it('never lets another agent reuse its id', async () => {
    const store = new AgentActivityStore(dir)
    const internal = store as unknown as { appendLines: (file: string, lines: string[]) => Promise<void> }
    const realAppend = internal.appendLines.bind(store)
    let partial = true
    internal.appendLines = async (file, lines) => {
      if (partial) {
        partial = false
        await appendFile(file, lines[0] + '\n')
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      }
      return realAppend(file, lines)
    }
    const start = Date.parse('2026-09-01T09:00:00Z')
    const a = { ...context, agentKey: 'A', label: 'A' }
    const b = { ...context, agentKey: 'B', label: 'B' }
    await expect(store.appendInterval({ context: a, startedAt: start, endedAt: start + HOUR })).rejects.toThrow('no space left')
    await store.appendInterval({ context: b, startedAt: start + HOUR, endedAt: start + 2 * HOUR })
    const restarted = new AgentActivityStore(dir)
    await restarted.appendInterval({ context: a, startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR })
    const read = await new AgentActivityStore(dir).readIntervals(start, start + 4 * HOUR)
    expect(read.map(interval => interval.context.agentKey)).toEqual(['B', 'A'])
  })
})

// #1414 review a round 2 (q115, "unknown is never empty"): an existing month
// file that cannot be READ was treated as absent, so a restarted store started
// ids at 1 and gave a second agent the id the first agent's lines already use.
// Once readable again, the first agent's later hours read back as the second
// agent's. Only ENOENT means "no file yet"; any other failure refuses the
// append, and the bytes stay as they were.
describe('an unreadable month file', () => {
  it('refuses the append instead of restarting ids, and ids continue once it is readable', async () => {
    const start = Date.parse('2026-09-01T09:00:00Z')
    const a = { ...context, agentKey: 'A', label: 'A' }
    const b = { ...context, agentKey: 'B', label: 'B' }
    await new AgentActivityStore(dir).appendInterval({ context: a, startedAt: start, endedAt: start + HOUR })
    const file = join(dir, '2026-09.jsonl')
    const before = await readFile(file)
    await chmod(file, 0o200)
    try {
      await expect(new AgentActivityStore(dir).appendInterval({ context: b, startedAt: start + HOUR, endedAt: start + 2 * HOUR })).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    expect(await readFile(file)).toEqual(before)
    const restarted = new AgentActivityStore(dir)
    await restarted.appendInterval({ context: b, startedAt: start + HOUR, endedAt: start + 2 * HOUR })
    await restarted.appendInterval({ context: a, startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR })
    const read = await new AgentActivityStore(dir).readIntervals(start, start + 4 * HOUR)
    expect(read.map(interval => interval.context.agentKey)).toEqual(['A', 'B', 'A'])
  })
})

// #1414 review b round 2 (test gap): a failed write that wrote NOTHING still
// consumed its id, and a restart must continue from the highest id on disk,
// not from the count of contexts (which would reissue a live id).
describe('an id gap left by a failed write', () => {
  it('is never filled by a later context after a restart', async () => {
    const store = new AgentActivityStore(dir)
    const internal = store as unknown as { appendLines: (file: string, lines: string[]) => Promise<void> }
    const realAppend = internal.appendLines.bind(store)
    let failNext = true
    internal.appendLines = async (file, lines) => {
      if (failNext) { failNext = false; throw Object.assign(new Error('no space left'), { code: 'ENOSPC' }) }
      return realAppend(file, lines)
    }
    const start = Date.parse('2026-09-01T09:00:00Z')
    const a = { ...context, agentKey: 'A', label: 'A' }
    const b = { ...context, agentKey: 'B', label: 'B' }
    const c = { ...context, agentKey: 'C', label: 'C' }
    await expect(store.appendInterval({ context: a, startedAt: start, endedAt: start + HOUR })).rejects.toThrow('no space left')
    await store.appendInterval({ context: b, startedAt: start + HOUR, endedAt: start + 2 * HOUR })
    const restarted = new AgentActivityStore(dir)
    await restarted.appendInterval({ context: c, startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR })
    await restarted.appendInterval({ context: b, startedAt: start + 3 * HOUR, endedAt: start + 4 * HOUR })
    const read = await new AgentActivityStore(dir).readIntervals(start, start + 5 * HOUR)
    expect(read.map(interval => interval.context.agentKey)).toEqual(['B', 'C', 'B'])
  })
})

// #1414 review a round 3 (q115): recovery treated an UNREADABLE open.json as
// "no open file" and overwrote it with an empty snapshot, so the pending
// interval was lost for good. Now an unreadable (or corrupt) snapshot is moved
// aside, bytes intact, and a later start recovers it once it can be read.
describe('an unreadable open-interval snapshot', () => {
  it('is set aside instead of overwritten, and recovered once readable', async () => {
    const start = Date.parse('2026-09-01T09:00:00Z')
    const lastTouch = start + 2 * HOUR
    await new AgentActivityStore(dir).writeOpen([{ sessionId: 'session-1', context, startedAt: start }], lastTouch)
    const file = join(dir, 'open.json')
    const before = await readFile(file)
    await chmod(file, 0o200)
    expect(await new AgentActivityStore(dir).recoverOpenIntervals(start + 10 * HOUR)).toBe(0)
    const aside = (await readdir(dir)).filter(name => name.startsWith('open.json.unrecovered-'))
    expect(aside).toHaveLength(1)
    await chmod(join(dir, aside[0]!), 0o600)
    expect(await readFile(join(dir, aside[0]!))).toEqual(before)
    // Readable again: the next start recovers it and removes the set-aside copy.
    expect(await new AgentActivityStore(dir).recoverOpenIntervals(start + 11 * HOUR)).toBe(1)
    expect((await readdir(dir)).filter(name => name.startsWith('open.json.unrecovered-'))).toEqual([])
    const read = await new AgentActivityStore(dir).readIntervals(start, start + 12 * HOUR)
    expect(read.map(interval => [interval.startedAt, interval.endedAt])).toEqual([[start, lastTouch]])
  })
})

// #1414 review c: a recovery that fails PARTWAY (the second entry's append
// fails) set the whole snapshot aside, so the next start re-appended the
// entry already recovered. Only the entries not yet recovered are set aside.
describe('a recovery that fails partway', () => {
  it('sets aside only what was not recovered, so nothing is counted twice', async () => {
    const start = Date.parse('2026-09-01T09:00:00Z')
    const lastTouch = start + 2 * HOUR
    const a = { ...context, agentKey: 'A', label: 'A' }
    const b = { ...context, agentKey: 'B', label: 'B' }
    await new AgentActivityStore(dir).writeOpen([
      { sessionId: 'session-a', context: a, startedAt: start },
      { sessionId: 'session-b', context: b, startedAt: start + HOUR },
    ], lastTouch)
    const store = new AgentActivityStore(dir)
    const internal = store as unknown as { appendLines: (file: string, lines: string[]) => Promise<void> }
    const realAppend = internal.appendLines.bind(store)
    let calls = 0
    internal.appendLines = async (file, lines) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      return realAppend(file, lines)
    }
    expect(await store.recoverOpenIntervals(start + 10 * HOUR)).toBe(1)
    expect(await new AgentActivityStore(dir).recoverOpenIntervals(start + 11 * HOUR)).toBe(1)
    const read = await new AgentActivityStore(dir).readIntervals(start, start + 12 * HOUR)
    expect(read.map(interval => interval.context.agentKey).sort()).toEqual(['A', 'B'])
  })

  // #1414 review c (test gap): a set-aside copy that still cannot be read is
  // KEPT for a later start, never deleted.
  it('keeps a set-aside copy that still cannot be read', async () => {
    const aside = join(dir, 'open.json.unrecovered-1000')
    await mkdir(dir, { recursive: true })
    await writeFile(aside, '{"aliveAt":1,"open":[]}')
    await chmod(aside, 0o200)
    try {
      await new AgentActivityStore(dir).recoverOpenIntervals(Date.parse('2026-09-01T12:00:00Z'))
      expect((await readdir(dir)).filter(name => name.startsWith('open.json.unrecovered-'))).toEqual(['open.json.unrecovered-1000'])
    } finally {
      await chmod(aside, 0o600)
    }
  })
})

// B6 check (q115): an aliases file that exists but cannot be READ was treated
// as absent twice over. The tail repair skipped its newline check, so a new
// edge was glued onto a torn last line and lost; and the aliases were cached
// as empty. Only ENOENT is "no file": otherwise the append is refused, the
// bytes are untouched, and nothing is cached, so a later call reads again.
describe('an unreadable aliases file', () => {
  it('refuses the append instead of gluing onto an unseen tail, and works once readable', async () => {
    const file = join(dir, 'aliases.jsonl')
    await mkdir(dir, { recursive: true })
    await writeFile(file, '{"f":"A","t":"B"}')
    const before = await readFile(file)
    await chmod(file, 0o200)
    try {
      await expect(new AgentActivityStore(dir).appendAliases([['B', 'C']])).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    expect(await readFile(file)).toEqual(before)
    await new AgentActivityStore(dir).appendAliases([['B', 'C']])
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { f: string; t: string })
    expect(lines).toEqual([{ f: 'A', t: 'B' }, { f: 'B', t: 'C' }])
  })

  // The READ path has one guard: `loadAliases`' ENOENT-only catch (B6 check,
  // 2110). The append test above cannot pin it, because the tail repair
  // refuses that append on its own. Here the SAME store instance reads while
  // the file is unreadable: with a catch-all, the empty map would be cached
  // and A and B would stay split for the life of the store.
  it('does not cache an unreadable file as empty: the same store groups once it is readable', async () => {
    const file = join(dir, 'aliases.jsonl')
    await mkdir(dir, { recursive: true })
    await writeFile(file, '{"f":"A","t":"B"}\n')
    const store = new AgentActivityStore(dir)
    await chmod(file, 0o200)
    try {
      await expect(store.agentKeyGrouping()).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    const group = await store.agentKeyGrouping()
    expect(group('A')).toBe(group('B'))
  })
})
