import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
})
