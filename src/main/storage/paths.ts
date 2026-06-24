import { join } from 'path'
import { homedir } from 'os'

import { APP_SLUG } from '@shared/appIdentity.js'

// Disk paths for persisted state.
//
// STATE_DIR follows XDG on Linux but uses ~/.config on macOS too —
// it's simpler than mirroring Electron's per-platform userData logic,
// the file is tiny, and the user has explicit control over it.
//
// This is the root for app-owned state, but it is no longer the only
// persistence root in the process: a few historical debug journals still live
// under Electron `userData` so older investigative files stay discoverable.
// Keep new cache-like diagnostics here unless a migration note explains why a
// historical `userData` root must be preserved.

export const STATE_DIR = join(homedir(), '.config', APP_SLUG)

// Tile tree + session metadata, written atomically by workspace:save.
// The renderer owns the JSON shape; main is a byte mover.
export const STATE_FILE = join(STATE_DIR, 'workspace.json')

// Per-session feed-debug append-only logs, one JSONL file per session.
// See storage/feedDebugLog.ts for the write-queue discipline.
export const FEED_DEBUG_DIR = join(STATE_DIR, 'feed-debug')

// Debug bundles have two separate roots because manual "Save Debug Logs" and
// background autosaves answer different questions. Manual saves are
// user-authored incident captures: they are intentionally discoverable, can
// receive notes, and should not be buried under thousands of interval
// snapshots. Autosaves are high-volume background forensics that retention can
// treat as disposable cache. Keeping both under DEBUG_BUNDLE_DIR gives us one
// parent to inspect/purge, while the child roots make the invariant obvious on
// disk and in the JSONL ledgers.
//
// Lives under STATE_DIR (not ~/Downloads or the project cwd) so bundles
// are colocated with the rest of Agent Code's on-disk state — one place to
// purge, one place to back up. The Save command shows the resulting
// path in a toast AND copies it to the clipboard, so discoverability
// doesn't depend on the user knowing the filesystem layout.
export const DEBUG_BUNDLE_DIR = join(STATE_DIR, 'debug-bundles')
export const MANUAL_DEBUG_BUNDLE_DIR = join(DEBUG_BUNDLE_DIR, 'manual')
export const AUTOSAVE_DEBUG_BUNDLE_DIR = join(DEBUG_BUNDLE_DIR, 'autosave')

// Wire-level proxy captures. Claude and Codex both write under this
// root so debug bundles and retention sweeps can treat them as one
// cache, regardless of provider.
export const PROXY_EVENTS_DIR = join(STATE_DIR, 'proxy')

// Environment-gated app performance traces. One folder per app run,
// written only when AGENT_CODE_PERF=1.
export const PERFORMANCE_RUNS_DIR = join(STATE_DIR, 'performance', 'runs')

// Heap snapshots are among the largest forensic artifacts the app can create.
// Keeping the directory as a named storage root prevents the capture paths from
// quietly drifting away from debug retention again; if a writer stores a
// `.heapsnapshot` somewhere else, that writer is opting out of the disk budget
// and should justify it in the diff.
export const HEAP_SNAPSHOT_DIR = join(STATE_DIR, 'heap-snapshots')
