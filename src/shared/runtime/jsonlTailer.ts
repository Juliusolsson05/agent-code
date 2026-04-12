import { watch } from 'chokidar'
import { createReadStream, statSync, unwatchFile, watchFile } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename } from 'path'

// Lives under src/core/runtime/ — Node-only (chokidar + fs). Imported by
// ClaudeSession (src/core/runtime/claudeSession.ts) and the testbench.
// NOT importable from the renderer.

/**
 * Watches a single JSONL file and emits parsed objects line-by-line as the
 * file grows. Append-only: it remembers a byte offset and reads everything
 * past it on the tick of a polling-based stat watcher.
 *
 * Partial trailing lines are buffered until the next read brings the
 * terminating newline.
 *
 * Why fs.watchFile (poll) instead of chokidar's fs.watch path:
 *   chokidar on macOS defaults to fs.watch-based change detection for
 *   single files, which is known to silently miss rapid appends from
 *   non-editor writers (append-only files that don't atomic-rename).
 *   Users saw it concretely: submit a prompt in cc-shell, CC writes
 *   the user entry + a bunch of attachments to the JSONL, and the
 *   feed wouldn't update until some unrelated later write nudged
 *   chokidar into re-reading. "The prompt didn't appear."
 *
 *   fs.watchFile polls stat() on an interval and fires whenever
 *   size/mtime changes. At 100ms interval the latency is imperceptible
 *   (~half a human reaction time), the CPU cost is trivial (one stat
 *   call every 100ms per tailer), and it's reliable on every fs/OS
 *   combination because it doesn't rely on kernel event delivery.
 *
 * Concurrency: `readNew()` can be triggered while a previous read is
 * still in flight — the fs.read stream is async, so its `end` handler
 * (where `offset` is advanced) runs on a future tick. Without
 * serialization a second trigger could read from a stale offset,
 * producing duplicate emits AND stomping `offset` backwards in the
 * first call's `end` handler. The `reading` / `pendingRead` flags
 * below form a simple "queue at most one re-entry" pattern: while a
 * read is in flight, subsequent triggers just set `pendingRead`; when
 * the in-flight read completes we immediately re-run if anything was
 * queued. This guarantees strict serialization with zero unbounded
 * queuing and zero concurrency.
 */
class FileTailer<T> {
  private offset = 0
  private buffer = ''
  private closed = false
  // Poll interval for fs.watchFile in milliseconds. 100ms gives
  // reliable pickup with imperceptible latency and negligible CPU.
  // Tuning lower doesn't noticeably help humans; tuning higher
  // starts to show up as "typing feels sluggish" when submit →
  // feed-update takes noticeable wall time.
  private static readonly POLL_INTERVAL_MS = 100
  private reading = false
  private pendingRead = false

  constructor(
    private readonly filePath: string,
    private readonly onEntry: (entry: T) => void,
    private readonly onError?: (err: Error) => void,
  ) {
    // Read whatever is already in the file synchronously on
    // construct — CC often writes several entries before the watcher
    // would tick. This gives us a clean baseline offset before the
    // poll loop starts.
    this.readNew()

    watchFile(
      filePath,
      { interval: FileTailer.POLL_INTERVAL_MS, persistent: true },
      (curr, prev) => {
        if (this.closed) return
        // Only act when the file has actually grown or its mtime
        // moved. stat returns size=0 when the file briefly
        // disappears (rare, but happens on some atomic-rename
        // writers); we let the next tick pick it back up.
        if (curr.size <= prev.size && curr.mtimeMs === prev.mtimeMs) {
          return
        }
        this.readNew()
      },
    )
  }

  private readNew(): void {
    if (this.closed) return
    if (this.reading) {
      // A read is in flight; queue a re-run instead of starting a
      // concurrent stream. See the class block comment for why
      // concurrent reads are unsafe.
      this.pendingRead = true
      return
    }
    this.reading = true

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch {
      // File temporarily missing — atomic-rename writers do this.
      // Skip and wait for the next poll tick.
      this.reading = false
      return
    }
    if (stat.size <= this.offset) {
      this.reading = false
      // If a re-run was queued while we were between the guard and
      // here, we still need to honor it even though this stat was a
      // no-op — the file may have grown between the two stats.
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
      return
    }

    const stream = createReadStream(this.filePath, {
      start: this.offset,
      end: stat.size - 1,
      encoding: 'utf8',
    })

    let chunk = ''
    stream.on('data', d => {
      chunk += d
    })
    stream.on('end', () => {
      this.offset = stat.size
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      // Last element is either '' (clean newline) or a partial line.
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed) as T
          this.onEntry(obj)
        } catch (err) {
          this.onError?.(err as Error)
        }
      }
      this.reading = false
      // Drain any queued re-run. This is the load-bearing bit for
      // serialization: when a write lands while we were reading the
      // previous chunk, the watcher sets pendingRead but can't do
      // anything else because reading was true. Now that we're done,
      // we kick off the next read ourselves.
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
    })
    stream.on('error', err => {
      this.reading = false
      this.onError?.(err)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    unwatchFile(this.filePath)
  }
}

export type JsonlEntry = Record<string, unknown>

/**
 * Watches a CC project directory for the JSONL file CC creates when the
 * session starts, then tails it. Use case:
 *
 *   1. cc-shell spawns `claude` with cwd=X
 *   2. Before/right after spawn, we call `tailNewSessionFile(projectDir, ...)`
 *   3. CC creates ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *   4. The tailer notices the new .jsonl, opens it, and starts emitting entries
 *
 * Returns a stop() function that tears down both the directory watcher
 * and the file tailer.
 */
export async function tailNewSessionFile(
  projectDir: string,
  onEntry: (entry: JsonlEntry, file: string) => void,
  onError?: (err: Error) => void,
): Promise<() => Promise<void>> {
  // Ensure the directory exists. CC creates it on first write but we want
  // to attach the watcher BEFORE CC is spawned so we can't miss the create
  // event. mkdir -p is harmless if it already exists.
  await mkdir(projectDir, { recursive: true })

  // Snapshot the existing files so we can ignore them and only pick up
  // a NEW jsonl produced by the session we're about to start.
  const existing = new Set<string>()
  try {
    for (const name of await readdir(projectDir)) {
      if (name.endsWith('.jsonl')) existing.add(name)
    }
  } catch (err) {
    onError?.(err as Error)
  }

  let tailer: FileTailer<JsonlEntry> | null = null

  const dirWatcher = watch(projectDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: false,
  })

  dirWatcher.on('add', filePath => {
    const name = basename(filePath)
    if (!name.endsWith('.jsonl')) return
    if (existing.has(name)) return
    if (tailer) return // Already tailing the first new session file
    tailer = new FileTailer<JsonlEntry>(
      filePath,
      entry => onEntry(entry, filePath),
      onError,
    )
  })

  dirWatcher.on('error', err => onError?.(err as Error))

  return async () => {
    await dirWatcher.close()
    if (tailer) await tailer.close()
  }
}

/**
 * Convenience for tailing a specific session file by absolute path
 * (when the file is already known).
 */
export function tailSessionFile(
  filePath: string,
  onEntry: (entry: JsonlEntry) => void,
  onError?: (err: Error) => void,
): () => Promise<void> {
  const tailer = new FileTailer<JsonlEntry>(filePath, onEntry, onError)
  return async () => {
    await tailer.close()
  }
}
