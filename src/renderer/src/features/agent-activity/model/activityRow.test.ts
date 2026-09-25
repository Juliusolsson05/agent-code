import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import type { GoalLoopState } from '@shared/types/goalLoop'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

import { attentionReason, buildActivityRows, EMPTY_FLEET_NOTES, filterActivityRows } from './activityRow'

// The row model is graded against the RECORDED fleet (#1105), never a
// hand-built one: a five-row fixture makes any sectioning rule look right.
//
//   runtime-states.json — 71 real SessionRuntime snapshots from debug bundles
//     (the renderer's own state for one session, written by the app);
//   owner-fleet-2026-09-19.json — the owner's window through the control MCP,
//     titles verbatim.
//
// Where a test needs a state the corpus does not contain (it has no live
// permission prompt, no usage limit, no process error), it starts from a REAL
// record and changes one field, so everything the rule does not look at is
// still the shape the app actually produces.

type RuntimeRecord = { sessionId: string; provider: string; runtime: Record<string, unknown> }
type FleetSession = { sessionId: string; title: string; displayedTitle: string; provider: string; project: string }

const fixtureDir = resolve(__dirname, '../../../../../../testing/fixtures/agent-activity')
const runtimeRecords = (JSON.parse(readFileSync(resolve(fixtureDir, 'runtime-states.json'), 'utf8')) as { records: RuntimeRecord[] }).records
const ownerFleet = (JSON.parse(readFileSync(resolve(fixtureDir, 'owner-fleet-2026-09-19.json'), 'utf8')) as { sessions: FleetSession[] }).sessions

/** A recorded runtime, completed with the fields the extractor did not keep
 *  (entries, semantic state), which default exactly as a fresh session's do. */
function hydrate(record: RuntimeRecord): SessionRuntime {
  return { ...emptyRuntime(), ...record.runtime } as SessionRuntime
}

function workspaceOf(sessions: Record<string, Partial<SessionMeta>>): WorkspaceState {
  const full: Record<string, SessionMeta> = {}
  let joinedAt = 0
  for (const [id, meta] of Object.entries(sessions)) {
    full[id] = { cwd: '/work/agent-code', projectId: 'project', joinedAt: joinedAt++, ...meta } as SessionMeta
  }
  return {
    activeTabId: 'project',
    tabs: [{ id: 'project', title: 'agent-code' }],
    sessions: full,
    pinnedSessionIds: [],
    stage: { lanes: [{ selectedSessionId: null }], rows: [{ length: 1 }], focusedLane: 0 },
  } as unknown as WorkspaceState
}

function rowFor(meta: Partial<SessionMeta>, runtime: SessionRuntime | undefined, notes = EMPTY_FLEET_NOTES) {
  const state = workspaceOf({ agent: meta })
  const rows = buildActivityRows(state, runtime ? { agent: runtime } : {}, notes)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

function recordNamed(prefix: string, predicate: (runtime: Record<string, unknown>) => boolean = () => true): RuntimeRecord {
  const record = runtimeRecords.find(item => item.sessionId.startsWith(prefix) && predicate(item.runtime))
  if (!record) throw new Error(`fixture record ${prefix} is missing — was runtime-states.json regenerated?`)
  return record
}

describe('Agent Activity sections, replayed against the recorded runtime corpus', () => {
  it('puts every recorded session in a section, and raises exactly the prompts that did not send', () => {
    // The corpus holds no live permission prompt, failed turn or usage limit
    // (its totals say so). What it DOES hold is two prompts the app could not
    // deliver: 6052830c refused while compaction blocked its input, idle, with
    // the draft kept; 39e22d50 "did not visibly absorb the prompt" while
    // running. Both are the user's own words stranded somewhere, which is a
    // request for attention. (A first draft of this test asserted the corpus
    // needed nothing at all, and the corpus disagreed.) Any OTHER row in this
    // section would be a normal state raised as a false alarm.
    const undelivered = new Set(runtimeRecords
      .filter(record => {
        // Optional: records from before promptDelivery existed (May 2026) lack it.
        const delivery = (record.runtime.promptDelivery as { kind: string } | undefined)?.kind
        return (delivery === 'failed-safe' || delivery === 'uncertain') && record.runtime.exited === null
      })
      .map(record => record.sessionId))
    expect(undelivered.size).toBe(2)

    const needsYou = runtimeRecords
      .map(record => ({ id: record.sessionId, row: rowFor({ kind: record.provider as SessionMeta['kind'] }, hydrate(record)) }))
      .filter(item => item.row.section === 'needs-you')
    expect(new Set(needsYou.map(item => item.id))).toEqual(undelivered)
    expect(needsYou.every(item => item.row.reason === 'Your prompt did not send')).toBe(true)
  })

  it('treats a queued prompt behind a working agent as normal, not as stuck', () => {
    // All 15 recorded queues sit behind an agent that is still working —
    // exactly when a queue is supposed to exist.
    const queued = runtimeRecords.filter(record => (record.runtime.queuedMessages as unknown[]).length > 0)
    expect(queued).toHaveLength(15)
    for (const record of queued) {
      expect(rowFor({ kind: record.provider as SessionMeta['kind'] }, hydrate(record)).section).toBe('working')
    }
  })

  it('does not raise a running or finished compaction as attention', () => {
    // The only live conditions in the corpus: Claude compaction banners,
    // `running` and `done`. Both are progress, not a question for the user.
    const compacting = runtimeRecords.filter(record => (record.runtime.conditions as ProviderConditionSnapshot | null)?.conditions?.['claude.compaction'])
    expect(compacting).toHaveLength(3)
    for (const record of compacting) {
      const runtime = hydrate(record)
      // One of them (6052830c) also carries the undelivered prompt above;
      // clear that one field so this asserts the banner alone.
      runtime.promptDelivery = { kind: 'idle' }
      expect(rowFor({ kind: 'claude' }, runtime).section).not.toBe('needs-you')
    }
  })

  it('sections the one recorded exited session as exited', () => {
    const record = recordNamed('9bd68e14', runtime => runtime.exited !== null)
    const row = rowFor({ kind: 'claude' }, hydrate(record))
    expect(row.section).toBe('exited')
    expect(row.reason).toBe('Exited')
  })
})

describe('what counts as "needs you" (one field changed on a real idle record)', () => {
  // 159ef909: a real Claude session, idle, no condition, nothing queued, its
  // last prompt delivered — the plainest idle state in the corpus. Every case
  // below changes exactly one thing.
  const idle = () => hydrate(recordNamed('159ef909'))

  it('the idle record itself needs nothing', () => {
    expect(rowFor({ kind: 'claude' }, idle()).section).toBe('idle')
  })

  it('a live permission prompt, in words rather than the badge text', () => {
    const runtime = idle()
    runtime.conditions = {
      provider: 'claude',
      ts: 1,
      conditions: { 'claude.permission-prompt': { kind: 'claude.permission-prompt', state: { visible: true }, actions: [] } },
    } as unknown as ProviderConditionSnapshot
    const row = rowFor({ kind: 'claude' }, runtime)
    expect(row.section).toBe('needs-you')
    expect(row.reason).toBe('Wants permission')
  })

  it('a queued prompt only once the agent has gone idle, and never a stale one', () => {
    const stuck = idle()
    stuck.queuedMessages = [{ content: 'next', timestamp: '2026-09-24T00:00:00Z' }]
    expect(rowFor({ kind: 'claude' }, stuck).reason).toBe('Queued prompt is not being sent')

    // Claude's unattributable residue: the queue strip already calls it
    // stale, and "your prompt is stuck" would be a false alarm about it.
    const stale = idle()
    stale.queuedMessages = [{ content: 'next', timestamp: '2026-09-24T00:00:00Z', stale: true }]
    expect(rowFor({ kind: 'claude' }, stale).section).toBe('idle')
  })

  it('a usage limit only while it is newer than the current turn', () => {
    // limitHit never self-clears (decomposition, correction 5): an agent that
    // resumed and worked past its limit must not keep the banner.
    const hit = idle()
    hit.turnStartedAt = 1_000
    hit.limitHit = { at: 2_000, source: 'transcript' }
    expect(rowFor({ kind: 'claude' }, hit).reason).toBe('Hit a usage limit')

    const pastIt = idle()
    pastIt.turnStartedAt = 3_000
    pastIt.limitHit = { at: 2_000, source: 'transcript' }
    expect(rowFor({ kind: 'claude' }, pastIt).section).toBe('idle')
  })

  it('a process error, and a prompt that did not send', () => {
    const errored = idle()
    errored.processError = 'spawn claude ENOENT'
    expect(rowFor({ kind: 'claude' }, errored).reason).toBe('Error: spawn claude ENOENT')

    const unsent = idle()
    unsent.promptDelivery = { kind: 'failed-safe', message: 'Enter was never pressed' }
    expect(rowFor({ kind: 'claude' }, unsent).reason).toBe('Your prompt did not send')
  })

  it('a goal loop that is blocked or paused, but not one that is running or done', () => {
    const loop = (patch: Partial<GoalLoopState>): GoalLoopState => ({
      sessionId: 'agent', goal: 'g', loopPrompt: 'p', phase: 'active', pauseReason: null, endReason: null,
      completionSummary: null, maxContinuations: 25, continuationsDelivered: 3, consecutiveDeliveryFailures: 0,
      startedAt: '', updatedAt: '', ...patch,
    })
    const meta = { kind: 'claude' } as SessionMeta
    expect(attentionReason(meta, idle(), loop({ phase: 'ended', endReason: 'blocked' }))).toBe('Goal loop is blocked on you')
    expect(attentionReason(meta, idle(), loop({ phase: 'paused', pauseReason: 'cap' }))).toBe('Goal loop paused (cap)')
    expect(attentionReason(meta, idle(), loop({ phase: 'active' }))).toBeNull()
    expect(attentionReason(meta, idle(), loop({ phase: 'ended', endReason: 'done' }))).toBeNull()
  })

  it('never asks a terminal anything, even when its runtime carries a condition snapshot', () => {
    // Provider capability lookups throw for 'terminal' (correction 4); a naive
    // loop over sessions would crash on the first shell.
    const runtime = idle()
    runtime.conditions = { provider: 'claude', ts: 1, conditions: {} } as unknown as ProviderConditionSnapshot
    expect(() => rowFor({ kind: 'terminal' }, runtime)).not.toThrow()
    expect(rowFor({ kind: 'terminal' }, runtime).section).not.toBe('needs-you')
  })
})

describe('row names on the owner\'s real fleet: title, then Goal, then folder', () => {
  // 11 recorded sessions, titles verbatim. The fleet has 3 explicit titles in
  // 33 and 0 spoken names, which is why the Goal term exists at all.
  const sessions: Record<string, Partial<SessionMeta>> = {}
  for (const session of ownerFleet) {
    sessions[session.sessionId] = {
      kind: session.provider as SessionMeta['kind'],
      title: session.title || undefined,
      cwd: `/Users/owner/Development/${session.displayedTitle === session.title ? 'agent-code' : session.displayedTitle}`,
      builtInMcpDomains: ['goal'],
    }
  }
  const untitled = ownerFleet.filter(session => !session.title.trim())
  const withGoal = untitled[0]!

  const rows = buildActivityRows(workspaceOf(sessions), {}, {
    ...EMPTY_FLEET_NOTES,
    goals: { [withGoal.sessionId]: { text: 'Make agent reloads go through one owner.\nSecond line.', updatedAt: '', revision: 1 } },
  })
  const byId = new Map(rows.map(row => [row.sessionId, row]))

  it('keeps every explicit title, verbatim, however long', () => {
    for (const session of ownerFleet.filter(item => item.title.trim())) {
      expect(byId.get(session.sessionId)).toMatchObject({ name: session.title.trim(), nameSource: 'title' })
    }
  })

  it('names an untitled agent by the first line of its Goal', () => {
    expect(byId.get(withGoal.sessionId)).toMatchObject({ name: 'Make agent reloads go through one owner.', nameSource: 'goal' })
  })

  it('falls back to the folder and SAYS it is the folder', () => {
    // The finding: three rows read `agent-code` and looked like one agent. The
    // name is still the folder, but the row now says it is one, instead of
    // presenting it as a name somebody chose.
    for (const session of untitled.slice(1)) {
      expect(byId.get(session.sessionId)?.nameSource).toBe('folder')
    }
  })

  it('lists parked pool agents, not only the ones on a lane', () => {
    // The old modal listed panes; every one of these is on no lane.
    expect(rows).toHaveLength(ownerFleet.length)
    expect(rows.every(row => !row.onLane)).toBe(true)
  })

  it('filters on every word, across name, project and provider', () => {
    const codex = filterActivityRows(rows, 'codex agent-code')
    expect(codex.length).toBeGreaterThan(0)
    expect(codex.every(row => row.kind === 'codex')).toBe(true)
    expect(filterActivityRows(rows, 'no-such-agent-anywhere')).toEqual([])
  })
})

describe('order inside a section', () => {
  it('puts the longest-idle agent first, because idle rows are there to be cleaned up', () => {
    const base = hydrate(recordNamed('159ef909'))
    const state = workspaceOf({ recent: { kind: 'claude' }, old: { kind: 'claude' } })
    const rows = buildActivityRows(state, {
      recent: { ...base, lastJsonlEntryAt: 5_000 },
      old: { ...base, lastJsonlEntryAt: 1_000 },
    }, EMPTY_FLEET_NOTES)
    expect(rows.map(row => row.sessionId)).toEqual(['old', 'recent'])
  })
})
