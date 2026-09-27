import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { readWorkflowJournalSnapshots } from 'workflow-mcp'
import type { WorkflowRunSummary, WorkflowStore } from 'workflow-mcp'

/**
 * Retention for `<userData>/workflows` (agent-code #1275).
 *
 * WHY this exists: nothing ever deleted a workflow run or the Codex rollouts its agents wrote. On
 * the owner's machine (2026-09-26), 134 runs held 623 MB and the workflow Codex home 718 MB after
 * nine days, about 140 MB a day with no ceiling. `debugRetention.ts` cannot reach it: it manages
 * `~/.config/agent-code`, and workflows live under Electron `userData`.
 *
 * WHY the policy is here and the deletion is in workflow-mcp: the package supplies mechanism
 * (`FileWorkflowStore.deleteRun`, which keeps its lease-scoped writer and indexes coherent); the
 * embedding app owns disk policy, as it does for every other budget.
 *
 * Plan: docs/plans/2026-09-26-workflow-run-retention.md.
 */

/** UNCONFIRMED default (owner may override): a week bounds the owner's rate to about 1 GB.
 *  `AGENT_CODE_WORKFLOW_RUN_TTL_DAYS` overrides it. Applies to lineages whose runs all completed. */
export const DEFAULT_WORKFLOW_RUN_TTL_DAYS = 7

/**
 * UNCONFIRMED default: lineages the user can still RESUME are kept longer.
 *
 * WHY (review of workflow-mcp#65): a failed, cancelled, interrupted or completed-with-errors run
 * stays visible in workflow history with a Resume action; once its manifest, journal and source are
 * deleted, Resume fails with run-not-found and nothing warned the user. On the owner's corpus 38 of
 * 134 runs were resumable. Thirty days keeps a month to act on them while still bounding growth;
 * the UI's handling of an expired run is follow-up #1348.
 */
export const RESUMABLE_TTL_MULTIPLIER = 30 / 7

const RESUMABLE = new Set<WorkflowRunSummary['status']>(['completed_with_errors', 'failed', 'cancelled', 'interrupted'])

const TERMINAL = new Set<WorkflowRunSummary['status']>([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'interrupted',
])

// A Codex thread id, the shape its rollout file names carry (ROLLOUT_FILE below). A recorded Codex
// session whose id is anything else is a shape we do not understand, and fails the pass closed.
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Codex names rollouts sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl.
const ROLLOUT_FILE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export type WorkflowRetentionStore = Pick<WorkflowStore, 'listRuns' | 'deleteRun' | 'reclaimDeletedRuns'> & {
  journalPath(runId: string): string
}

export type WorkflowRetentionResult = {
  runsDeleted: number
  rolloutsDeleted: number
  /** Lineages skipped because a delete failed part-way; retried on the next pass. */
  lineagesFailed: number
  /**
   * True when rollout pruning was skipped for this whole pass because some kept run's journal
   * could not be read or understood (steering q64/q66): its references are unknown, not empty.
   */
  rolloutsSkipped: boolean
  /**
   * Deleted runs whose bytes are still on disk after this pass retried them (workflow-mcp#65,
   * round 4): a locked or failing directory is reported, not silently assumed gone.
   */
  runsUnreclaimed: number
}

export function workflowRunTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENT_CODE_WORKFLOW_RUN_TTL_DAYS)
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKFLOW_RUN_TTL_DAYS
  return days * 24 * 60 * 60_000
}

export async function pruneWorkflowHistory(input: {
  store: WorkflowRetentionStore
  /** The WORKFLOW Codex home (never the interactive ~/.codex). */
  codexHome: string
  now: number
  ttlMs: number
}): Promise<WorkflowRetentionResult> {
  const { store, codexHome, now, ttlMs } = input
  const cutoff = now - ttlMs
  const result: WorkflowRetentionResult = { runsDeleted: 0, rolloutsDeleted: 0, lineagesFailed: 0, rolloutsSkipped: false, runsUnreclaimed: 0 }
  if (!store.listRuns || !store.deleteRun) return result

  const runs = await allRuns(store)
  const lineages = new Map<string, WorkflowRunSummary[]>()
  for (const run of runs) lineages.set(run.lineageId, [...(lineages.get(run.lineageId) ?? []), run])

  const kept: WorkflowRunSummary[] = []
  for (const members of lineages.values()) {
    // WHY whole lineages only: WorkflowService startup treats an `interrupted` run with no
    // successor as un-continued and may AUTO-RECOVER it. Deleting a successor while its
    // interrupted predecessor stays could make an old workflow re-run on its own. So a lineage is
    // pruned only when every member is terminal and every member is past the cutoff.
    const lineageCutoff = members.some(run => RESUMABLE.has(run.status)) ? now - ttlMs * RESUMABLE_TTL_MULTIPLIER : cutoff
    const prunable = members.every(run => TERMINAL.has(run.status) && Date.parse(run.updatedAt) < lineageCutoff)
    if (!prunable) {
      kept.push(...members)
      continue
    }
    // Predecessors first: a crash part-way leaves a successor whose predecessor is gone (harmless),
    // never an interrupted predecessor without its successor (auto-recovered).
    const ordered = ancestryOrder(members)
    for (let index = 0; index < ordered.length; index += 1) {
      try {
        await store.deleteRun(ordered[index]!.runId)
        result.runsDeleted += 1
      } catch {
        // Stop this lineage here; the rest stays for the next pass (and keeps its sessions).
        kept.push(...ordered.slice(index))
        result.lineagesFailed += 1
        break
      }
    }
  }

  // Retry the bytes of runs deleted earlier (this pass's or a previous one's) that the store could
  // not remove; what remains is reported. After this pass's deletes, so their leftovers count too.
  if (store.reclaimDeletedRuns) result.runsUnreclaimed = (await store.reclaimDeletedRuns()).remaining

  const referenced = await referencedCodexSessions(store, kept)
  if (referenced === undefined) {
    result.rolloutsSkipped = true
    return result
  }
  result.rolloutsDeleted = await pruneRollouts(join(codexHome, 'sessions'), cutoff, referenced)
  return result
}

/**
 * Members ordered so every run comes after the run it resumed.
 *
 * WHY ancestry and not `createdAt` (review of workflow-mcp#65): createdAt is wall-clock time. A
 * clock step backwards, or equal timestamps with the (createdAt, runId) tie-break, could put a
 * successor first; a crash after deleting it would leave the interrupted predecessor looking
 * un-continued, which startup may auto-recover. `resumedFromRunId` is the edge startup itself
 * reads. A member whose predecessor is not in the lineage (already gone) counts as a root.
 */
function ancestryOrder(members: WorkflowRunSummary[]): WorkflowRunSummary[] {
  const byId = new Map(members.map(run => [run.runId, run]))
  const children = new Map<string, WorkflowRunSummary[]>()
  const roots: WorkflowRunSummary[] = []
  for (const run of members) {
    const parent = run.resumedFromRunId
    if (parent !== undefined && byId.has(parent) && parent !== run.runId) {
      children.set(parent, [...(children.get(parent) ?? []), run])
    } else {
      roots.push(run)
    }
  }
  const byAge = (left: WorkflowRunSummary, right: WorkflowRunSummary) => left.createdAt.localeCompare(right.createdAt)
  const ordered: WorkflowRunSummary[] = []
  const seen = new Set<string>()
  const queue = [...roots].sort(byAge)
  while (queue.length > 0) {
    const run = queue.shift()!
    if (seen.has(run.runId)) continue
    seen.add(run.runId)
    ordered.push(run)
    queue.push(...(children.get(run.runId) ?? []).sort(byAge))
  }
  // A cycle (corrupt data) leaves members unvisited; they go last rather than being dropped.
  for (const run of members) if (!seen.has(run.runId)) ordered.push(run)
  return ordered
}

async function allRuns(store: WorkflowRetentionStore): Promise<WorkflowRunSummary[]> {
  const runs: WorkflowRunSummary[] = []
  let cursor: string | undefined
  do {
    const page = await store.listRuns!({ limit: 200, ...(cursor === undefined ? {} : { cursor }) })
    runs.push(...page.items)
    cursor = page.hasMore ? page.nextCursor : undefined
  } while (cursor !== undefined)
  return runs
}

/**
 * Every Codex thread a kept run's journal references, or `undefined` when that cannot be known.
 *
 * WHY undefined fails the whole rollout pass closed (steering q64/q66): the first version caught
 * any read error and moved on, so an unreadable kept journal (EACCES, a torn write) counted as
 * "references nothing", and every old rollout it needed for Resume was deleted. Not knowing a
 * run's references is not the same as it having none; one unknown journal therefore skips
 * rollout pruning for the pass, and the next daily pass tries again.
 *
 * WHY the package's reader and not a regex over the file: `readWorkflowJournalSnapshots` is the
 * validation resume itself uses (format, version, sessions shape, size cap), so a journal
 * retention cannot understand is exactly one resume could not use either. Real journals (the
 * owner's 133, 2026-09-27) all store sessions as `snapshots[].sessions[].session`
 * `{provider, id}` — 1,095 of them, all Codex with thread-id-shaped ids. A MISSING journal is
 * "no references" here, as it is for the package's reader: one real failed run from July never
 * wrote one.
 */
async function referencedCodexSessions(
  store: WorkflowRetentionStore,
  kept: WorkflowRunSummary[],
): Promise<Set<string> | undefined> {
  const ids = new Set<string>()
  for (const run of kept) {
    let snapshots: Awaited<ReturnType<typeof readWorkflowJournalSnapshots>>
    try {
      snapshots = await readWorkflowJournalSnapshots(store.journalPath(run.runId))
    } catch {
      return undefined
    }
    for (const snapshot of snapshots) {
      for (const record of snapshot.sessions ?? []) {
        // Other providers' sessions are not Codex rollouts; they cannot protect or expose one.
        if (record.session.provider !== 'codex') continue
        if (!CODEX_THREAD_ID.test(record.session.id)) return undefined
        ids.add(record.session.id)
      }
    }
  }
  return ids
}

/**
 * Delete rollouts older than the cutoff whose thread no kept run references.
 *
 * WHY both conditions: the journal reference protects a session a kept run can still resume; the
 * age guard protects sessions no journal recorded (an attempt killed before recording, or one
 * imported from the interactive home). Deleting a rollout does not corrupt Codex's sqlite index —
 * a missing file is looked up again and the row self-heals — but the rows are not reclaimed
 * (follow-up issue; only Codex's own thread/delete removes them).
 */
async function pruneRollouts(sessionsRoot: string, cutoff: number, referenced: Set<string>): Promise<number> {
  let deleted = 0
  for (const path of await rolloutFiles(sessionsRoot)) {
    const id = ROLLOUT_FILE.exec(path.slice(path.lastIndexOf('/') + 1))?.[1]
    if (id === undefined || referenced.has(id)) continue
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue
      await rm(path, { force: true })
      deleted += 1
    } catch {
      // Raced with Codex or already gone: nothing to do.
    }
  }
  return deleted
}

async function rolloutFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await rolloutFiles(path)))
    // Only the rollout name pattern (checked in pruneRollouts) makes a file eligible.
    else if (entry.isFile()) files.push(path)
  }
  return files
}
