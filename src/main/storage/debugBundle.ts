import { mkdir, writeFile } from 'fs/promises'
import { dirname, join, normalize } from 'path'

import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
import {
  appendDebugBundleSaved,
  debugBundleRootForReason,
} from '@main/storage/debugBundleLog.js'

// Debug-bundle writer.
//
// The renderer assembles the bundle (it has every diagnostic source:
// runtime.semantic, runtime.feedDebugLog, the DOM outerHTML, and can
// run sanitizeHtml locally) and ships the pre-serialized files here
// in a single IPC call. Main owns filesystem layout + atomicity and
// returns the absolute bundle path so the renderer can surface it.
//
// Why the renderer assembles vs. main assembling:
//   The data lives in three different places in the renderer
//   (workspace runtime store, the live DOM, sanitizeHtml in
//   @renderer/lib). Forwarding all of that through IPC in structured
//   form would recreate those representations in main just to
//   stringify them back out. Shipping the already-stringified files
//   is one round-trip, no schema duplication, and keeps main a thin
//   byte-mover — same discipline as workspace.json (see paths.ts).
//
// Why per-invocation folders instead of a single shared dir:
//   A bundle is a coherent snapshot — all files were captured at the
//   same instant from the same pane. Mixing multiple invocations
//   into one folder would make it ambiguous which proxy-semantic.json
//   goes with which feed-debug.jsonl. Timestamped folders also double
//   as a history: the user can compare "before / after" bundles
//   without manual renaming.

export type DebugBundleFile = {
  /** File path relative to the bundle folder. Validated as a
   *  portable relative path — no absolute paths, no `..` segments. */
  name: string
  /** Text content. Binary files are not supported because none of
   *  the debug surfaces produce binary data today (HTML capture is
   *  a DOM string, everything else is JSON/JSONL). */
  content: string
}

export type SaveDebugBundleParams = {
  /** Session id the bundle is for. Used only to build the folder
   *  name — the payload itself already encodes what session it
   *  came from inside manifest.json. */
  sessionId: string
  kind?: string | null
  reason?: string | null
  cwd?: string | null
  providerSessionId?: string | null
  /** Opaque files list. Main does not look inside `content`. */
  files: DebugBundleFile[]
}

export type SaveDebugBundleResult = {
  /** Absolute path of the created bundle folder. Returned so the
   *  renderer can show it in a toast and copy to clipboard. */
  bundlePath: string
}

// Same regex as sanitizeSessionIdForPath in feedDebugLog.ts —
// deliberately narrow to prevent path traversal via a malformed
// session id and to keep folder names portable across macOS/Windows.
function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// Bundle folder naming: `<ISO-like timestamp-with-ms>-<sessionShort>`.
//
// Why colon-free ISO: macOS tolerates ':' in file names but many
// tools (and Windows) don't, and the user WILL be copy-pasting this
// path into a terminal. `2026-04-23T14-32-07` reads unambiguously
// as a date+time and sorts lexicographically. Keep milliseconds
// because autosave can race a manual save or close-save inside the
// same second; silently overwriting a just-written debug bundle is
// worse than a slightly longer folder name.
//
// Why include the 8-char session id: if the user saves two bundles
// from two different panes in the same second, bare timestamp would
// collide. Short prefix keeps the folder name readable while
// disambiguating.
function buildBundleFolderName(sessionId: string, now: Date): string {
  const iso = now.toISOString()
  // `2026-04-23T14:32:07.842Z` → `2026-04-23T14-32-07-842`
  const stamp = iso.replace(/Z$/, '').replace(/[:.]/g, '-')
  const short = sanitizeForPath(sessionId.slice(0, 8))
  return `${stamp}-${short}`
}

// Validate that a bundle file path stays inside the timestamped
// folder. Root-level debug files still pass (`manifest.json`), and
// trace files can now live in controlled subfolders
// (`trace/html/commits.jsonl`). Absolute paths, empty segments, and
// `..` are rejected.
function isSafeRelativePath(name: string): boolean {
  if (!name || name.length > 512) return false
  if (name.startsWith('/') || name.startsWith('\\')) return false
  if (/^[a-zA-Z]:[\\/]/.test(name)) return false
  const rawParts = name.split(/[\\/]/)
  if (rawParts.some(part => !part || part === '.' || part === '..' || part.length > 255)) {
    return false
  }
  const normalized = normalize(name)
  if (normalized.startsWith('..')) return false
  return true
}

export async function saveDebugBundle(
  params: SaveDebugBundleParams,
): Promise<SaveDebugBundleResult> {
  if (!params?.sessionId || !Array.isArray(params.files) || params.files.length === 0) {
    throw new Error('saveDebugBundle: missing sessionId or empty files list')
  }
  for (const file of params.files) {
    if (!isSafeRelativePath(file.name)) {
      throw new Error(`saveDebugBundle: unsafe file path: ${JSON.stringify(file.name)}`)
    }
  }

  const bundleFolderName = buildBundleFolderName(params.sessionId, new Date())
  const bundleRoot = debugBundleRootForReason(params.reason)
  const bundlePath = join(bundleRoot, bundleFolderName)

  // mkdir recursive handles both the manual/autosave root (first invocation
  // ever) and the new per-bundle folder in one call.
  await mkdir(bundlePath, { recursive: true })

  // Sequential writes. Could parallelize with Promise.all but bundles
  // are small (a few files, typically < 1MB total) and a serial loop
  // keeps error messages unambiguous — a failure names the file that
  // actually failed, not an aggregate rejection that's harder to act
  // on when debugging Agent Code itself (which is the whole point of
  // this feature).
  for (const file of params.files) {
    const target = join(bundlePath, file.name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
  }

  try {
    await appendDebugBundleSaved({
      bundlePath,
      sessionId: params.sessionId,
      kind: params.kind ?? null,
      reason: params.reason ?? null,
      cwd: params.cwd ?? null,
      providerSessionId: params.providerSessionId ?? null,
    })
  } catch (err) {
    // WHY the index is best-effort: the timestamped bundle folder is the
    // durable artifact the user asked us to save. The JSONL is only a lookup
    // aid for future browsing. Reporting "save failed" after every file was
    // already written would make the worst disk-pressure case actively
    // misleading and would also skip the note prompt for a usable bundle.
    console.warn('[debug-bundle] failed to append saved-bundle index entry', err)
  }

  scheduleDebugStoragePrune('debug-bundle-save')

  return { bundlePath }
}
