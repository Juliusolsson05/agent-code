import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FileWorkflowStore,
  PersistentWorkflowJournal,
  parseWorkflowSource,
  type JournalMiss,
  type WorkflowEvent,
} from 'workflow-mcp'

import { pruneWorkflowHistory, workflowRunTtlMs } from './workflowRetention.js'

// agent-code #1275. Every run here is created, advanced and terminated through the REAL
// FileWorkflowStore paths, and the session reference goes through the REAL journal API, so the
// retention pass sees exactly the on-disk shape production writes. Only the clock is faked (Date
// alone, so filesystem I/O is untouched) to give runs different ages.

const DAY = 24 * 60 * 60_000
const T0 = Date.parse('2026-09-10T12:00:00.000Z')
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function workflow() {
  return parseWorkflowSource(`export const meta = { name: 'retained', description: 'Retention fixture' }
    return 'ok'`)
}

function event(runId: string, sequence: number, type: WorkflowEvent['type'], payload: unknown): WorkflowEvent {
  return {
    schemaVersion: 1, runId, sequence, eventId: `event-${sequence}`, timestamp: new Date().toISOString(), type, payload,
  } as WorkflowEvent
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-retention-'))
  roots.push(root)
  const store = new FileWorkflowStore(join(root, 'workflows'))
  await store.acquireLease('retention-test')
  await store.initialize()
  const codexHome = join(root, 'workflows', 'codex-home')
  return { root, store, codexHome }
}

async function terminalRun(
  store: FileWorkflowStore,
  runId: string,
  ending: 'run.interrupted' | 'run.cancelled' | 'run.completed',
  lineage?: { resumedFromRunId: string; lineageId: string },
): Promise<void> {
  await store.createRun({ runId, cwd: tmpdir(), workflow: workflow(), ...(lineage ?? {}) })
  await store.appendEvent(runId, event(runId, 1, 'run.started', { workflow: { name: 'retained', description: 'Retention fixture' } }))
  if (ending === 'run.completed') {
    // The production completion path: persist the result, then publish run.completed naming it.
    const result = await store.persistResult(runId, {
      serializedContent: '"ok"',
      reference: { preview: '"ok"', content: '"ok"', mediaType: 'application/json', lineCount: 1, truncated: false },
    })
    await store.appendEvent(runId, event(runId, 2, ending, { result }))
    return
  }
  await store.appendEvent(runId, event(runId, 2, ending, { reason: 'fixture' }))
}

async function recordCodexSession(store: FileWorkflowStore, runId: string, threadId: string): Promise<void> {
  const journal = await PersistentWorkflowJournal.open(store.journalPath(runId), [], store.journalWriteCoordinator())
  const run = journal.beginRun({ workflowId: 'root', sourceHash: workflow().sourceHash })
  run.recordProviderSession(run.admit({ agentId: 'agent_1', prompt: 'work' }) as JournalMiss, { provider: 'codex', id: threadId })
}

async function rollout(codexHome: string, threadId: string, ageDays: number, now: number): Promise<string> {
  const directory = join(codexHome, 'sessions', '2026', '09', '10')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `rollout-2026-09-10T12-00-00-${threadId}.jsonl`)
  await writeFile(path, '{"type":"session_meta"}\n')
  const at = new Date(now - ageDays * DAY)
  await utimes(path, at, at)
  return path
}

const exists = (path: string) => stat(path).then(() => true, () => false)
const ids = async (store: FileWorkflowStore) => (await store.listRuns({ limit: 50 })).items.map(run => run.runId).sort()

describe('workflow run retention (#1275)', () => {
  it('prunes an old, fully terminal lineage and keeps fresh and live runs', async () => {
    const { store, codexHome } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    // An old lineage whose latest run completed (interrupted -> completed): nothing is resumable.
    vi.setSystemTime(T0)
    await terminalRun(store, 'run_old_first', 'run.interrupted')
    await terminalRun(store, 'run_old_second', 'run.completed', { resumedFromRunId: 'run_old_first', lineageId: 'run_old_first' })
    // Old but never finished: not terminal, so never a candidate, however stale.
    await store.createRun({ runId: 'run_old_unfinished', cwd: tmpdir(), workflow: workflow() })
    await store.appendEvent('run_old_unfinished', event('run_old_unfinished', 1, 'run.started', { workflow: { name: 'retained', description: 'Retention fixture' } }))
    vi.setSystemTime(T0 + 9 * DAY)
    await terminalRun(store, 'run_fresh', 'run.cancelled')
    await store.createRun({ runId: 'run_live', cwd: tmpdir(), workflow: workflow() })

    const result = await pruneWorkflowHistory({ store, codexHome, now: T0 + 9 * DAY, ttlMs: 7 * DAY })

    expect(result).toMatchObject({ runsDeleted: 2, lineagesFailed: 0 })
    expect(await ids(store)).toEqual(['run_fresh', 'run_live', 'run_old_unfinished'])
  })

  // The hazard: startup auto-recovers an `interrupted` run with no successor. Deleting only the
  // old predecessor is harmless, but deleting a successor alone would resurrect it — so a lineage
  // with ANY fresh member is kept whole.
  it('keeps a whole lineage while any member is fresh, even its old interrupted predecessor', async () => {
    const { store, codexHome } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    await terminalRun(store, 'run_old_interrupted', 'run.interrupted')
    vi.setSystemTime(T0 + 9 * DAY)
    await terminalRun(store, 'run_fresh_successor', 'run.cancelled', { resumedFromRunId: 'run_old_interrupted', lineageId: 'run_old_interrupted' })

    const result = await pruneWorkflowHistory({ store, codexHome, now: T0 + 9 * DAY, ttlMs: 7 * DAY })

    expect(result.runsDeleted).toBe(0)
    expect(await ids(store)).toEqual(['run_fresh_successor', 'run_old_interrupted'])
  })

  // Owner decision 2026-09-27: a lineage with any resumable run (failed, cancelled, interrupted,
  // completed with errors) is never deleted; only a completed-only lineage ages out.
  it('never deletes a resumable lineage, however old, and prunes an old completed one', async () => {
    const { store, codexHome } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    await terminalRun(store, 'run_resumable', 'run.cancelled')
    await store.createRun({ runId: 'run_completed', cwd: tmpdir(), workflow: workflow() })
    await store.appendEvent('run_completed', event('run_completed', 1, 'run.started', { workflow: { name: 'retained', description: 'Retention fixture' } }))
    // The production completion path: persist the result, then publish run.completed naming it.
    const result = await store.persistResult('run_completed', {
      serializedContent: '"ok"',
      reference: { preview: '"ok"', content: '"ok"', mediaType: 'application/json', lineCount: 1, truncated: false },
    })
    await store.appendEvent('run_completed', event('run_completed', 2, 'run.completed', { result }))

    const pruned = await pruneWorkflowHistory({ store, codexHome, now: T0 + 3650 * DAY, ttlMs: 7 * DAY })

    expect(await ids(store)).toEqual(['run_resumable'])
    expect(pruned.runsDeleted).toBe(1)
  })

  // Owner decision 2026-09-27, and why it is judged on the lineage's LEAVES: a resumed chain always
  // has resumable predecessors, so a lineage whose latest run completed is finished and ages out,
  // while one whose latest run failed or was cancelled still offers Resume and is kept forever.
  it('keeps a lineage whose latest run is resumable, and prunes one whose latest run completed', async () => {
    const { store, codexHome } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    await terminalRun(store, 'run_done_first', 'run.interrupted')
    await terminalRun(store, 'run_done_last', 'run.completed', { resumedFromRunId: 'run_done_first', lineageId: 'run_done_first' })
    await terminalRun(store, 'run_open_first', 'run.completed')
    await terminalRun(store, 'run_open_last', 'run.cancelled', { resumedFromRunId: 'run_open_first', lineageId: 'run_open_first' })

    const pruned = await pruneWorkflowHistory({ store, codexHome, now: T0 + 3650 * DAY, ttlMs: 7 * DAY })

    expect(pruned.runsDeleted).toBe(2)
    expect(await ids(store)).toEqual(['run_open_first', 'run_open_last'])
  })

  // Review of workflow-mcp#65: createdAt is wall-clock; a clock step backwards must not make the
  // successor go first (a crash in between would leave an un-continued interrupted predecessor).
  it('deletes predecessors before successors even when the clock stepped backwards', async () => {
    const { store, codexHome } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 - 40 * DAY)
    await terminalRun(store, 'run_parent', 'run.interrupted')
    vi.setSystemTime(T0 - 40 * DAY - 60_000)
    await terminalRun(store, 'run_child', 'run.completed', { resumedFromRunId: 'run_parent', lineageId: 'run_parent' })
    const order: string[] = []
    const deleteRun = store.deleteRun.bind(store)
    const spied = Object.assign(Object.create(store) as FileWorkflowStore, {
      deleteRun: async (runId: string) => { order.push(runId); await deleteRun(runId) },
      listRuns: store.listRuns.bind(store),
      journalPath: store.journalPath.bind(store),
      reclaimDeletedRuns: store.reclaimDeletedRuns.bind(store),
    })

    await pruneWorkflowHistory({ store: spied, codexHome, now: T0, ttlMs: 7 * DAY })

    expect(order).toEqual(['run_parent', 'run_child'])
  })

  it('deletes an old unreferenced rollout, and keeps one a kept run references or one that is fresh', async () => {
    const { store, codexHome } = await fixture()
    const now = T0 + 9 * DAY
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    await terminalRun(store, 'run_kept', 'run.interrupted')
    const referencedThread = '01a0d58e-15a1-7a82-b1f6-0fbb899414b9'
    await recordCodexSession(store, 'run_kept', referencedThread)
    const orphan = await rollout(codexHome, '01a0d58e-1d92-7611-9809-14790ab1730a', 9, now)
    const referenced = await rollout(codexHome, referencedThread, 9, now)
    const fresh = await rollout(codexHome, '01a0d58e-2222-7611-9809-14790ab1730a', 1, now)
    // Not a rollout: never touched, whatever its age.
    const other = join(codexHome, 'sessions', '2026', '09', '10', 'notes.jsonl')
    await writeFile(other, '{}\n')
    await utimes(other, new Date(now - 30 * DAY), new Date(now - 30 * DAY))

    const result = await pruneWorkflowHistory({ store, codexHome, now, ttlMs: 7 * DAY })

    expect(result.rolloutsDeleted).toBe(1)
    expect(await exists(orphan)).toBe(false)
    expect(await exists(referenced)).toBe(true)
    expect(await exists(fresh)).toBe(true)
    expect(await exists(other)).toBe(true)
  })

  // Steering q64/q66: an unreadable or corrupt KEPT journal means its references are unknown, not
  // empty. The first version skipped it and deleted the old rollout that run needs for Resume. The
  // whole rollout pass must fail closed; the journal is damaged through the real file the store
  // wrote, not a stand-in.
  it.each([
    ['unreadable (EACCES)', async (path: string) => { await chmod(path, 0o000) }],
    ['truncated', async (path: string) => {
      const text = await readFile(path, 'utf8')
      await writeFile(path, text.slice(0, Math.floor(text.length / 2)))
    }],
  ] as const)('prunes no rollout at all when a kept run journal is %s', async (_label, damage) => {
    const { store, codexHome } = await fixture()
    const now = T0 + 9 * DAY
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    await terminalRun(store, 'run_kept', 'run.interrupted')
    const referencedThread = '01a0d58e-15a1-7a82-b1f6-0fbb899414b9'
    await recordCodexSession(store, 'run_kept', referencedThread)
    const referenced = await rollout(codexHome, referencedThread, 9, now)
    const orphan = await rollout(codexHome, '01a0d58e-1d92-7611-9809-14790ab1730a', 9, now)
    const journal = store.journalPath('run_kept')
    await damage(journal)
    try {
      const result = await pruneWorkflowHistory({ store, codexHome, now, ttlMs: 7 * DAY })
      expect(result).toMatchObject({ rolloutsDeleted: 0, rolloutsSkipped: true })
      // Both survive: the referenced one because its reference is unknowable this pass, and the
      // orphan because nothing can be proven unreferenced while one journal is unknown.
      expect(await exists(referenced)).toBe(true)
      expect(await exists(orphan)).toBe(true)
    } finally {
      await chmod(journal, 0o600).catch(() => undefined)
    }
  })

  // Steering q66: "reject unknown shapes rather than assume an empty set". Every real Codex session
  // id is a thread id (1,095 of 1,095 in the owner's journals); one that is not is a format this
  // pass does not understand, so it cannot be matched to a rollout name and fails the pass closed.
  it('prunes no rollout when a kept journal records a Codex session id of an unknown shape', async () => {
    const { store, codexHome } = await fixture()
    const now = T0 + 9 * DAY
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    await terminalRun(store, 'run_kept', 'run.interrupted')
    await recordCodexSession(store, 'run_kept', 'thread:01a0d58e-15a1-7a82-b1f6-0fbb899414b9')
    const orphan = await rollout(codexHome, '01a0d58e-1d92-7611-9809-14790ab1730a', 9, now)
    const result = await pruneWorkflowHistory({ store, codexHome, now, ttlMs: 7 * DAY })
    expect(result).toMatchObject({ rolloutsDeleted: 0, rolloutsSkipped: true })
    expect(await exists(orphan)).toBe(true)
  })

  // workflow-mcp#65, round 4: a deleted run whose bytes cannot be removed is reported, and the next
  // pass retries it — never silently assumed gone.
  it('reports a deleted run it could not reclaim, and reclaims it on a later pass', async () => {
    const { root, store, codexHome } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    await terminalRun(store, 'run_old', 'run.completed')
    const locked = join(root, 'workflows', 'runs', 'run_old', 'transcripts', 'locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'agent.jsonl'), '{}\n')
    await chmod(locked, 0o500)
    try {
      const first = await pruneWorkflowHistory({ store, codexHome, now: T0 + 40 * DAY, ttlMs: 7 * DAY })
      expect(first).toMatchObject({ runsDeleted: 1, runsUnreclaimed: 1 })
      const [trash] = store.listUnreclaimedDeletions()
      await chmod(join(root, 'workflows', 'runs', trash!, 'transcripts', 'locked'), 0o700)
      const second = await pruneWorkflowHistory({ store, codexHome, now: T0 + 41 * DAY, ttlMs: 7 * DAY })
      expect(second).toMatchObject({ runsDeleted: 0, runsUnreclaimed: 0 })
    } finally {
      await chmod(locked, 0o700).catch(() => undefined)
    }
  })

  it('reads the TTL from the environment, defaulting to 90 days (owner decision)', () => {
    expect(workflowRunTtlMs({})).toBe(90 * DAY)
    expect(workflowRunTtlMs({ AGENT_CODE_WORKFLOW_RUN_TTL_DAYS: '14' })).toBe(14 * DAY)
    expect(workflowRunTtlMs({ AGENT_CODE_WORKFLOW_RUN_TTL_DAYS: 'nonsense' })).toBe(90 * DAY)
  })
})
