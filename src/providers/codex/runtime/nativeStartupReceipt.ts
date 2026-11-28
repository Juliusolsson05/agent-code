import { watch, type FSWatcher } from 'node:fs'
import { open, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { findCodexRolloutPathByThreadId } from 'codex-headless'

type Owner = {
  observeProviderThreadIdentity(id: string): void
  getSessionMeta(): { id: string } | null
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const receiptName = /^start\.[a-zA-Z0-9]+\.json$/

type ThreadHint = { id: string; bucketPath?: string }

function startupThread(raw: string): ThreadHint | null {
  const event = JSON.parse(raw)
  if (event?.hook_event_name !== 'SessionStart' || event.source !== 'startup' ||
    event.agent_id != null || event.agent_type != null ||
    typeof event.session_id !== 'string' || !UUID.test(event.session_id)) return null
  const id = event.session_id.toLowerCase()
  if (event.transcript_path != null && (typeof event.transcript_path !== 'string' ||
    !basename(event.transcript_path).toLowerCase().endsWith(`-${id}.jsonl`))) return null
  // Only the documented date bucket and filename can select a fast-path read
  // under the host's own sessions root. Never open a provider-supplied path.
  const bucketPath = typeof event.transcript_path === 'string'
    ? /\/(\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl)$/.exec(event.transcript_path)?.[1]
    : undefined
  return { id, bucketPath }
}

async function rootMetadata(file: string, id: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    // Match the locator's bounded prefix. A valid subagent rollout can also
    // have a perfectly consistent UUID/filename, but cannot own this TUI.
    const prefix = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    const line = JSON.parse(prefix.toString('utf8', 0, bytesRead).split('\n', 1)[0]!)
    return line.type === 'session_meta' && line.payload?.id?.toLowerCase() === id &&
      line.payload.source === 'cli' && line.payload.parent_thread_id == null
  } finally { await handle.close() }
}

/** SessionStart is a launch-scoped statement from Codex itself. The file may
 * arrive before headless starts or before the first rollout record is durable.
 * Keep its UUID until the regular coordinator proves ownership and tails it. */
export class NativeStartupReceipt {
  private watcher?: FSWatcher
  private timer?: NodeJS.Timeout
  private stopped = false

  constructor(private directory: string) {}

  start(sessionsDir: string, owner: Owner): void {
    if (this.stopped) return
    let delay = 100
    let busy = false
    let dirty = false
    const inspect = async () => {
      if (this.stopped || busy) return
      busy = true
      let retry = false
      try {
        retry = await this.offerReceipts(sessionsDir, owner)
      } catch { retry = true } finally {
        busy = false
        if (!this.stopped && (dirty || retry || !this.watcher)) {
          const timeout = dirty ? 0 : delay
          delay = Math.min(delay * 2, 30_000)
          dirty = false
          this.timer = setTimeout(() => void inspect(), timeout)
          this.timer.unref()
        }
      }
    }
    const wake = () => {
      clearTimeout(this.timer)
      if (busy) dirty = true
      else void inspect()
    }
    try {
      this.watcher = watch(this.directory, { persistent: false }, (_event, name) => {
        if (name === null || receiptName.test(name)) wake()
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = undefined
        wake()
      })
    } catch { /* Poll at a capped backoff when the OS cannot provide a watcher. */ }
    wake()
  }

  /** Report whether a receipt still needs another look. An unrelated or child
   * receipt cannot block the root waiting beside it in the same directory. */
  private async offerReceipts(sessionsDir: string, owner: Owner): Promise<boolean> {
    let pending = false
    for (const name of await readdir(this.directory)) {
      if (this.stopped || !receiptName.test(name)) continue
      const path = join(this.directory, name)
      if (owner.getSessionMeta()) {
        this.stop()
        await unlink(path).catch(() => {})
        return false
      }

      let hint: ThreadHint | null = null
      try { hint = startupThread(await readFile(path, 'utf8')) } catch { /* Invalid or retired receipt. */ }
      if (hint) {
        try {
          const file = hint.bucketPath
            ? join(sessionsDir, hint.bucketPath)
            : await findCodexRolloutPathByThreadId(sessionsDir, hint.id)
          if (!file) { pending = true; continue }
          if (await rootMetadata(file, hint.id)) {
            if (!this.stopped) owner.observeProviderThreadIdentity(hint.id)
            pending = true
            continue
          }
        } catch {
          // SessionStart can run before the file exists or its header is complete.
          pending = true
          continue
        }
      }
      await unlink(path).catch(() => {})
    }
    return pending
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    clearTimeout(this.timer)
  }
}
