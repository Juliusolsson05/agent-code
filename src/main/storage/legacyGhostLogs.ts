import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Delete the on-disk ghost logs the app no longer writes or reads.
 *
 * WHY the feature is gone (owner decision, 2026-09-25; #1227, #1225):
 * `<userData>/ghost-logs/<sessionId>.ghost.jsonl` persisted the renderer's
 * provisional rows so a pane that crashed mid-turn could show them after a
 * restart. Nothing had read those files since the July recovery rewrite
 * (0cb71e99): the only reader looked them up under a freshly minted spawn id.
 * Meanwhile they had grown to 2.1 GB on the owner's machine (1,935 of 1,955
 * files belonging to sessions that no longer existed), had OOM'd main once
 * (2026-05-11), and needed their own compaction and retention code. Reviving
 * the reader (#1227) showed it also needs clock and identity machinery to
 * avoid painting committed turns twice, for a rare case whose restored text
 * the agent's own resumed conversation does not contain. The in-memory ghosts
 * (the live streaming preview) are unaffected.
 *
 * WHY every launch and not once behind a marker: `rm` of a missing directory
 * with `force` is a cheap no-op, and a marker would be one more file to get
 * wrong. It runs in the background because a 2 GB directory takes a moment,
 * and nothing waits on it. Failure is logged and harmless: the files are
 * inert, and the next launch tries again.
 *
 * This whole module can be deleted a few releases after the removal has
 * shipped, once no install still carries the directory.
 */
export async function removeLegacyGhostLogs(userDataDir: string): Promise<void> {
  try {
    await rm(join(userDataDir, 'ghost-logs'), { recursive: true, force: true })
  } catch (err) {
    console.warn('[legacyGhostLogs] could not remove the old ghost-logs directory (non-fatal):', err)
  }
}
