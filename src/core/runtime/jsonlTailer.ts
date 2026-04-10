import { watch, type FSWatcher } from 'chokidar'
import { createReadStream, statSync } from 'fs'
import { mkdir, readdir } from 'fs/promises'
import { basename } from 'path'

// Lives under src/core/runtime/ — Node-only (chokidar + fs). Imported by
// ClaudeSession (src/core/runtime/claudeSession.ts) and the testbench.
// NOT importable from the renderer.

/**
 * Watches a single JSONL file and emits parsed objects line-by-line as the
 * file grows. Append-only: it remembers a byte offset and reads everything
 * past it on each chokidar 'change' event.
 *
 * Partial trailing lines are buffered until the next read brings the
 * terminating newline.
 */
class FileTailer<T> {
  private offset = 0
  private buffer = ''
  private watcher: FSWatcher
  private closed = false

  constructor(
    private readonly filePath: string,
    private readonly onEntry: (entry: T) => void,
    private readonly onError?: (err: Error) => void,
  ) {
    // Read whatever is already in the file (CC may have written entries
    // before our watcher attached — race window is small but real).
    this.readNew()

    this.watcher = watch(filePath, {
      persistent: true,
      // We're targeting a single file, so disable directory traversal.
      depth: 0,
      awaitWriteFinish: false,
      // chokidar's default polling on macOS works fine for append-mode files.
      usePolling: false,
    })

    this.watcher.on('change', () => this.readNew())
    this.watcher.on('error', err => this.onError?.(err as Error))
  }

  private readNew(): void {
    if (this.closed) return
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch {
      // File temporarily missing — atomic-rename writers do this. Skip and
      // wait for the next change event.
      return
    }
    if (stat.size <= this.offset) return

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
    })
    stream.on('error', err => this.onError?.(err))
  }

  async close(): Promise<void> {
    this.closed = true
    await this.watcher.close()
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
