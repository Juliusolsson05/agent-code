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

// Main-owned desired state and ownership journal for the optional personal
// conventions skill. Provider copies are integration surfaces, never the source
// of truth; keeping this beside workspace state gives recovery one stable path.
export const AGENT_CODE_CONVENTIONS_STATE_FILE = join(STATE_DIR, 'conventions.json')

// Immutable package bytes imported through Installed Skills live outside the
// revisioned JSON document. The document records a content digest and manifest;
// this private content-addressed root holds the corresponding binary files
// without forcing assets through JSON/base64 or the renderer process.
export const AGENT_CODE_INSTALLED_SKILL_SNAPSHOTS_DIR = join(
  STATE_DIR,
  'managed-skill-snapshots',
)

// Private per-process header files for Codex TLDR turn hooks (#917), each
// holding one live session bearer. WHY app-owned rather than os.tmpdir(): the
// file is read on every hook for the whole life of the process, and macOS
// clears files in its per-user temp directory after three days, which would
// silently switch enforcement off for a long-idle pane. Every entry belongs to
// a process of this app run, so startup deletes whatever an earlier run left.
export const TLDR_HOOK_RUNTIME_DIR = join(STATE_DIR, 'tldr-hooks')

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

// Product monitoring is always on, so it cannot share the environment-gated
// trace root above. A distinct root also lets its hard 128 MiB retention rule
// prune only the bounded metric history it owns.
export const MONITOR_HISTORY_DIR = join(STATE_DIR, 'performance-monitor')

// Always-on app-run incident journals. Unlike performance traces, this root is
// not gated by AGENT_CODE_PERF: it holds the small manifest/heartbeat/event
// spine that explains crashes and restarts in normal user runs. Large forensic
// artifacts stay in their own roots and are referenced from journal records so
// this directory remains cheap to retain.
export const INCIDENT_RUNS_DIR = join(STATE_DIR, 'incidents', 'runs')

// Heap snapshots are among the largest forensic artifacts the app can create.
// Keeping the directory as a named storage root prevents the capture paths from
// quietly drifting away from debug retention again; if a writer stores a
// `.heapsnapshot` somewhere else, that writer is opting out of the disk budget
// and should justify it in the diff.
export const HEAP_SNAPSHOT_DIR = join(STATE_DIR, 'heap-snapshots')

// Explicit recordings (Chromium traces, main CPU profiles, heap snapshots) are
// written here first and renamed to the user's chosen destination only once
// complete. WHY not a temp file beside the destination: a quit or crash during
// a 30-second trace stranded `*.agent-code-<pid>.tmp` files in the user's own
// Desktop/Downloads, where nothing owned by the app would ever clean them.
// This root is app-owned and swept at startup, before any capture can begin.
export const PERFORMANCE_CAPTURE_TEMP_DIR = join(STATE_DIR, 'performance-capture-tmp')

// Session recordings — continuous debug-gated capture of a session's
// rendering-pipeline input stream, replayable in the test suite (see
// docs/rendering/session-recording-plan-2026-07.md, issue #467). Written
// ONLY when AGENT_CODE_DEV_DEBUG=1 AND AGENT_CODE_SESSION_RECORD=1. Each
// recording is a self-contained folder (`<recordingId>/` holding meta.json
// + events.jsonl) so a single recording can be deleted wholesale with one
// `rm -rf` — the per-folder shape is a deliberate cleanup affordance. Like
// every other debug root here it must register with debugRetention as a
// budgeted bucket (a continuous recorder re-opens the #388 OOM/disk vector).
export const SESSION_RECORDING_DIR = join(STATE_DIR, 'session-recordings')

// Durable per-conversation identity (title, spoken name, orchestration role)
// keyed by provider-native session id, projected from workspace saves. Lives
// beside workspace.json because it is derived from it, and stays a separate
// file because it must outlive any pane the workspace forgets.
export const CONVERSATIONS_DIR = join(STATE_DIR, 'conversations')
export const CONVERSATIONS_LEDGER_FILE = join(CONVERSATIONS_DIR, 'ledger.jsonl')
