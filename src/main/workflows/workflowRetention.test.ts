import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
  ending: 'run.interrupted' | 'run.cancelled',
  lineage?: { resumedFromRunId: string; lineageId: string },
): Promise<void> {
  await store.createRun({ runId, cwd: tmpdir(), workflow: workflow(), ...(lineage ?? {}) })
  await store.appendEvent(runId, event(runId, 1, 'run.started', { workflow: { name: 'retained', description: 'Retention fixture' } }))
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
    vi.setSystemTime(T0)
    await terminalRun(store, 'run_old_first', 'run.interrupted')
    await terminalRun(store, 'run_old_second', 'run.cancelled', { resumedFromRunId: 'run_old_first', lineageId: 'run_old_first' })
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

  it('reads the TTL from the environment, defaulting to 7 days', () => {
    expect(workflowRunTtlMs({})).toBe(7 * DAY)
    expect(workflowRunTtlMs({ AGENT_CODE_WORKFLOW_RUN_TTL_DAYS: '14' })).toBe(14 * DAY)
    expect(workflowRunTtlMs({ AGENT_CODE_WORKFLOW_RUN_TTL_DAYS: 'nonsense' })).toBe(7 * DAY)
  })
})
