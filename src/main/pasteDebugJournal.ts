// Per-paste debug-event writer.
//
// Mirror of `src/main/dictationJournal.ts` from PR #68. Same 100 ms
// drain cadence, same mkdir-on-first-write trick, same "process owns
// the writer until quit, flushAll on before-quit" lifecycle. The two
// files are deliberately near-duplicates; a shared
// `BatchedJsonlWriter` is YAGNI until a third caller shows up.
//
// One file per paste-press:
//   <userData>/paste-debug/<pasteId>.paste.jsonl
//
// `pasteId` is a renderer-minted UUID stamped at the moment Enter is
// observed in the composer keydown handler. Keying the file on it
// rather than on, say, the sessionId guarantees that every paste —
// including ones that never reach the PTY — has its own file. That
// matters for the "first Enter does nothing" bug we are chasing: a
// dropped paste won't share a file with the eventual successful one
// after the user presses Enter again.
//
// Privacy contract:
//   * file mode 0o600, dir mode 0o700
//   * never log raw PTY bytes — callers send sha8 + byte count
//   * composer text head (truncated 240 chars) IS logged; the whole
//     point is to see what reached Claude vs. what the user typed
//   * file is local user-private; no network surface
//
// Disk-pressure contract:
//   * `pruneOldPasteDebugLogs()` runs at startup; 14-day retention
//   * a file per paste × hundreds of pastes/day adds up; without
//     pruning we'd grow forever

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { PasteDebugEvent, PasteDebugEventInput } from '@preload/api/types.js'

const FLUSH_INTERVAL_MS = 100

const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

export class PasteDebugJournal {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private ensuredDir = false
  private draining = false
  private sessionStartedAtMs: number | null = null

  constructor(private readonly filePath: string) {}

  append(input: PasteDebugEventInput): void {
    const now = Date.now()
    if (this.sessionStartedAtMs === null) this.sessionStartedAtMs = now
    const event: PasteDebugEvent = {
      ts: now,
      tMs: now - this.sessionStartedAtMs,
      ...input,
    }
    this.queue.push(JSON.stringify(event) + '\n')
    this.scheduleDrain()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
  }

  private scheduleDrain(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, FLUSH_INTERVAL_MS)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    if (this.queue.length === 0) return
    this.draining = true
    try {
      const batch = this.queue.splice(0).join('')
      await this.appendRaw(batch)
    } finally {
      this.draining = false
    }
    if (this.queue.length > 0 && !this.timer) this.scheduleDrain()
  }

  private async appendRaw(content: string): Promise<void> {
    try {
      await appendFile(this.filePath, content, { mode: 0o600 })
    } catch {
      if (!this.ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.ensuredDir = true
        await appendFile(this.filePath, content, { mode: 0o600 })
      } else {
        throw new Error(`paste-debug append failed for ${this.filePath}`)
      }
    }
  }
}

export class PasteDebugJournalRegistry {
  private journals = new Map<string, PasteDebugJournal>()

  get(pasteId: string): PasteDebugJournal {
    let j = this.journals.get(pasteId)
    if (!j) {
      j = new PasteDebugJournal(pasteDebugLogPath(pasteId))
      this.journals.set(pasteId, j)
    }
    return j
  }

  async flushAll(): Promise<void> {
    const drains = [...this.journals.values()].map(j =>
      j.flush().catch(err => {
        console.warn('[pasteDebugJournal] flush error:', err)
      }),
    )
    await Promise.all(drains)
  }

  dispose(pasteId: string): void {
    const j = this.journals.get(pasteId)
    if (!j) return
    void j.flush().catch(err => {
      console.warn('[pasteDebugJournal] dispose flush error:', err)
    })
    this.journals.delete(pasteId)
  }
}

export function pasteDebugLogPath(pasteId: string): string {
  return join(
    app.getPath('userData'),
    'paste-debug',
    `${pasteId}.paste.jsonl`,
  )
}

export async function pruneOldPasteDebugLogs(): Promise<void> {
  const dir = join(app.getPath('userData'), 'paste-debug')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const name of entries) {
    if (!name.endsWith('.paste.jsonl')) continue
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.mtimeMs < cutoff) await unlink(full)
    } catch {
      // ignore
    }
  }
}
