import { join } from 'path'
import { homedir } from 'os'

import { APP_SLUG, LEGACY_APP_SLUG } from '@shared/appIdentity.js'

// Disk paths for persisted state.
//
// STATE_DIR follows XDG on Linux but uses ~/.config on macOS too —
// it's simpler than mirroring Electron's per-platform userData logic,
// the file is tiny, and the user has explicit control over it.
// Everything persisted by Agent Code lives under this one directory.

export const STATE_DIR = join(homedir(), '.config', APP_SLUG)
export const LEGACY_STATE_DIR = join(homedir(), '.config', LEGACY_APP_SLUG)

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
// are colocated with the rest of Agent Code's on-disk state — one place to
// purge, one place to back up. The Save command shows the resulting
// path in a toast AND copies it to the clipboard, so discoverability
// doesn't depend on the user knowing the filesystem layout.
export const DEBUG_BUNDLE_DIR = join(STATE_DIR, 'debug-bundles')

// Wire-level proxy captures. Claude and Codex both write under this
// root so debug bundles and retention sweeps can treat them as one
// cache, regardless of provider.
export const PROXY_EVENTS_DIR = join(STATE_DIR, 'proxy')

// Environment-gated app performance traces. One folder per app run,
// written only when AGENT_CODE_PERF=1. CC_SHELL_PERF remains accepted
// as a legacy compatibility alias.
export const PERFORMANCE_RUNS_DIR = join(STATE_DIR, 'performance', 'runs')
