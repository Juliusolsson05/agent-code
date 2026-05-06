import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'path'
import { homedir } from 'os'

// Disk paths for persisted state.
//
// STATE_DIR follows XDG on Linux but uses ~/.config on macOS too —
// it's simpler than mirroring Electron's per-platform userData logic,
// the file is tiny, and the user has explicit control over it.
// Everything persisted by cc-shell lives under this one directory.

export const STATE_DIR = join(homedir(), '.config', 'cc-shell')

// Tile tree + session metadata, written atomically by workspace:save.
// The renderer owns the JSON shape; main is a byte mover.
export const STATE_FILE = join(STATE_DIR, 'workspace.json')

// Per-session feed-debug append-only logs, one JSONL file per session.
// See storage/feedDebugLog.ts for the write-queue discipline.
export const FEED_DEBUG_DIR = join(STATE_DIR, 'feed-debug')

// One subfolder per explicit "Save Debug Logs" palette invocation.
// Each invocation creates a timestamped folder inside this root with a
// snapshot of the focused pane's diagnostic state (state + feed-debug +
// proxy semantic + HTML capture). Parallel to FEED_DEBUG_DIR but writes
// are user-triggered rather than streaming.
//
// Lives under STATE_DIR (not ~/Downloads or the project cwd) so bundles
// are colocated with the rest of cc-shell's on-disk state — one place to
// purge, one place to back up. The Save command shows the resulting
// path in a toast AND copies it to the clipboard, so discoverability
// doesn't depend on the user knowing the filesystem layout.
export const DEBUG_BUNDLE_DIR = join(STATE_DIR, 'debug-bundles')

// Environment-gated app performance traces. One folder per app run,
// written only when CC_SHELL_PERF=1.
export const PERFORMANCE_RUNS_DIR = join(STATE_DIR, 'performance', 'runs')

// Why a 30-day cutoff: the feed-debug JSONL is forensic evidence for
// "what was the renderer thinking before this bug?" Bugs fresh enough
// to debug are rarely older than a few weeks; a debug bundle saved a
// month later is so unusual it's not worth the disk pressure (we have
// observed users with 149 GB / 5007 .jsonl files accumulated). 30
// days balances "the user can still investigate" against "the disk
// doesn't grow forever."
const FEED_DEBUG_RETENTION_DAYS = 30

/** Sweep `~/.config/cc-shell/feed-debug` and remove `.jsonl` files
 *  whose mtime is older than the cutoff. We retain by mtime not by
 *  count so a user with many short sessions keeps recent context and
 *  a user with few long sessions does not lose the active session's
 *  log. Default 30 days because a debug bundle saved a month later
 *  is so unusual it's not worth the disk pressure to support. */
export async function pruneStaleFeedDebugLogs(): Promise<{ removed: number; bytesFreed: number }> {
  const dir = FEED_DEBUG_DIR
  let removed = 0
  let bytesFreed = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // Directory missing is the common case on a fresh install — no
    // logs to sweep. Returning early keeps startup quiet.
    return { removed, bytesFreed }
  }
  const cutoff = Date.now() - FEED_DEBUG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const stats = await stat(file)
      if (stats.mtimeMs >= cutoff) continue
      bytesFreed += stats.size
      await unlink(file)
      removed += 1
    } catch {
      // Ignore — file may have been removed concurrently or be busy.
    }
  }
  return { removed, bytesFreed }
}
