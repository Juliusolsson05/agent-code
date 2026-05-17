import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { STATE_DIR } from '@main/storage/paths.js'
import type { IndexedTranscript, WorktreeActivityIndexFile } from '@main/worktreeActivity/types.js'

const INDEX_VERSION = 2
const INDEX_FILE = join(STATE_DIR, 'worktree-activity-index.json')

export function emptyIndexFile(): WorktreeActivityIndexFile {
  return {
    version: INDEX_VERSION,
    updatedAt: 0,
    transcripts: {},
  }
}

export async function loadWorktreeActivityIndex(): Promise<WorktreeActivityIndexFile> {
  try {
    const text = await readFile(INDEX_FILE, 'utf8')
    const parsed = JSON.parse(text) as Partial<WorktreeActivityIndexFile>
    // Version mismatch means parser semantics changed. Drop the old
    // compact index rather than trying to migrate guesses; the raw
    // transcripts are still available and the next background refresh
    // can rebuild from source. This keeps migrations cheap until the
    // index becomes user-visible data rather than derived cache.
    if (parsed.version !== INDEX_VERSION || !parsed.transcripts) {
      return emptyIndexFile()
    }
    return {
      version: INDEX_VERSION,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      transcripts: parsed.transcripts as Record<string, IndexedTranscript>,
    }
  } catch {
    return emptyIndexFile()
  }
}

/**
 * Point lookup of a single transcript by its file path, going to disk
 * each call. Used by WorktreeActivityIndex when its in-memory LRU
 * misses on a path that may still exist on disk — we don't want a
 * miss to silently lose data, but we also don't want every miss to
 * pull the entire 30 MB+ JSON into memory permanently.
 *
 * Why a point read by re-parsing the whole file: the on-disk format
 * is a single JSON document, not line-delimited, so we can't do a
 * cheap streaming lookup. The file is read, parsed, the entry
 * extracted, and the parsed object goes out of scope. The transient
 * peak is the same as a normal load — what we avoid is RETAINING the
 * full map across calls.
 *
 * If this becomes hot enough to matter, the next refactor is a
 * line-delimited on-disk format (one transcript per JSONL line) so
 * point lookups can scan without parsing the rest. That's a bigger
 * change than the current OOM problem warrants.
 */
export async function loadEntryFromDisk(
  path: string,
): Promise<IndexedTranscript | null> {
  try {
    const text = await readFile(INDEX_FILE, 'utf8')
    const parsed = JSON.parse(text) as Partial<WorktreeActivityIndexFile>
    if (parsed.version !== INDEX_VERSION || !parsed.transcripts) return null
    const entry = (parsed.transcripts as Record<string, IndexedTranscript>)[path]
    return entry ?? null
  } catch {
    return null
  }
}

/**
 * Load every transcript from disk as a fresh Record. Used by callers
 * (e.g., collectSummaries) that need to iterate the full set. The
 * returned object is a transient — callers must not retain it across
 * calls, because doing so would defeat the purpose of the in-memory
 * LRU cap.
 *
 * Why this exists separately from loadWorktreeActivityIndex: that
 * function is the one-shot loader on startup, and conceptually
 * returns the canonical index. This function expresses the "I am
 * paying the cost of a full read on purpose" intent at the call
 * site, so future readers know which calls are hot.
 */
export async function loadAllTranscriptsFromDisk(): Promise<
  Record<string, IndexedTranscript>
> {
  const file = await loadWorktreeActivityIndex()
  return file.transcripts
}

export async function saveWorktreeActivityIndex(
  index: WorktreeActivityIndexFile,
): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  const next = {
    ...index,
    version: INDEX_VERSION,
    updatedAt: Date.now(),
  }
  // WHY the temp path is unique even though the index is only a derived cache:
  //
  // The app policy is one primary process, but this index is refreshed in the
  // background and is cheap to make robust against accidental overlap. A fixed
  // `.tmp` sibling lets two refreshes from identity-split dev/prod processes
  // steal each other's scratch file and surface noisy ENOENT failures. The
  // final file can remain last-writer-wins because raw provider transcripts are
  // the source of truth; the scratch file just needs to be owned by one write.
  const tmp = `${INDEX_FILE}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(next), 'utf8')
  await rename(tmp, INDEX_FILE)
}
