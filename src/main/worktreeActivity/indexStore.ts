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

export async function saveWorktreeActivityIndex(
  index: WorktreeActivityIndexFile,
): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true })
  const next = {
    ...index,
    version: INDEX_VERSION,
    updatedAt: Date.now(),
  }
  const tmp = INDEX_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(next), 'utf8')
  await rename(tmp, INDEX_FILE)
}
