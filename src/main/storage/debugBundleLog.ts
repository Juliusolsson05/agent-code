import { appendFile, mkdir, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

import {
  AUTOSAVE_DEBUG_BUNDLE_DIR,
  DEBUG_BUNDLE_DIR,
  MANUAL_DEBUG_BUNDLE_DIR,
} from '@main/storage/paths.js'

export const MANUAL_DEBUG_BUNDLE_LOG_FILE = join(MANUAL_DEBUG_BUNDLE_DIR, 'saved-debug-bundles.jsonl')
export const AUTOSAVE_DEBUG_BUNDLE_LOG_FILE = join(
  AUTOSAVE_DEBUG_BUNDLE_DIR,
  'autosaved-debug-bundles.jsonl',
)
// Legacy mixed ledger kept as an exported constant because older troubleshooting
// scripts and user instructions may still point at this file. New saves do not
// append here; storage selection now happens through debugBundleLogFileForReason.
export const DEBUG_BUNDLE_LOG_FILE = join(DEBUG_BUNDLE_DIR, 'saved-debug-bundles.jsonl')
const DEBUG_BUNDLE_NOTE_FILE = 'note.json'

export type DebugBundleLogSavedEntry = {
  schemaVersion: 1
  event: 'saved'
  ts: number
  tsIso: string
  bundlePath: string
  sessionId: string
  kind: string | null
  reason: string | null
  cwd: string | null
  providerSessionId: string | null
}

export type DebugBundleLogNoteEntry = {
  schemaVersion: 1
  event: 'note-added'
  ts: number
  tsIso: string
  bundlePath: string
  note: string
}

export type DebugBundleLogEntry = DebugBundleLogSavedEntry | DebugBundleLogNoteEntry

export function isAutosaveDebugBundleReason(reason?: string | null): boolean {
  return typeof reason === 'string' && reason.startsWith('autosave-')
}

export function debugBundleRootForReason(reason?: string | null): string {
  // WHY the split keys off reason instead of a new IPC field: every renderer
  // caller already labels the capture as either `manual` or `autosave-*`, and
  // main is the storage owner. Requiring another parallel boolean would create
  // two sources of truth where disagreement could put a manual incident capture
  // back into the noisy autosave cache.
  return isAutosaveDebugBundleReason(reason) ? AUTOSAVE_DEBUG_BUNDLE_DIR : MANUAL_DEBUG_BUNDLE_DIR
}

export function debugBundleLogFileForReason(reason?: string | null): string {
  return isAutosaveDebugBundleReason(reason)
    ? AUTOSAVE_DEBUG_BUNDLE_LOG_FILE
    : MANUAL_DEBUG_BUNDLE_LOG_FILE
}

export function debugBundleLogFileForBundlePath(bundlePath: string): string {
  const target = resolve(bundlePath)
  const autosaveRoot = resolve(AUTOSAVE_DEBUG_BUNDLE_DIR)
  const rel = relative(autosaveRoot, target)
  // WHY notes normally only come from manual saves, but this helper keeps the
  // storage contract honest if a future caller attaches a note to an autosave
  // bundle. The ledger should follow the bundle's root instead of silently
  // polluting the manual incident index with metadata for cache artifacts.
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    ? AUTOSAVE_DEBUG_BUNDLE_LOG_FILE
    : MANUAL_DEBUG_BUNDLE_LOG_FILE
}

function nowFields(now = Date.now()): { ts: number; tsIso: string } {
  return { ts: now, tsIso: new Date(now).toISOString() }
}

function isInsideDebugBundleDir(path: string): boolean {
  const root = resolve(DEBUG_BUNDLE_DIR)
  const target = resolve(path)
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function appendDebugBundleLogEntry(
  file: string,
  entry: DebugBundleLogEntry,
): Promise<void> {
  // WHY this stays a plain append instead of a locked/fsync'd ledger: the
  // folder on disk is the source of truth. This file is an operator-friendly
  // index for "what did I save and why?", so losing the last line on a crash
  // or racing a same-process append is acceptable. Making the debug-save path
  // block on stronger durability would be the wrong trade for a command used
  // while the app is already misbehaving.
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function appendDebugBundleSaved(params: {
  bundlePath: string
  sessionId: string
  kind?: string | null
  reason?: string | null
  cwd?: string | null
  providerSessionId?: string | null
}): Promise<void> {
  await appendDebugBundleLogEntry(debugBundleLogFileForReason(params.reason), {
    schemaVersion: 1,
    event: 'saved',
    ...nowFields(),
    bundlePath: resolve(params.bundlePath),
    sessionId: params.sessionId,
    kind: params.kind ?? null,
    reason: params.reason ?? null,
    cwd: params.cwd ?? null,
    providerSessionId: params.providerSessionId ?? null,
  })
}

export async function addDebugBundleNote(params: {
  bundlePath: string
  note: string
}): Promise<void> {
  if (!params?.bundlePath || typeof params.bundlePath !== 'string') {
    throw new Error('addDebugBundleNote: missing bundlePath')
  }
  if (!isInsideDebugBundleDir(params.bundlePath)) {
    throw new Error('addDebugBundleNote: bundlePath escapes debug bundle dir')
  }
  const note = typeof params.note === 'string' ? params.note.trim() : ''
  if (!note) return

  const created = nowFields()
  const notePath = join(resolve(params.bundlePath), DEBUG_BUNDLE_NOTE_FILE)
  // WHY notes live beside the bundle instead of only in the global JSONL:
  // the JSONL is an index, but the bundle folder is the unit the user opens
  // later. Keeping a small note.json inside the bundle means a copied folder
  // remains self-describing even if the global index is pruned, moved, or not
  // shared with the bundle. It is intentionally not part of manifest.json:
  // the manifest describes the files captured at save time, while this note
  // is user-authored follow-up metadata that can be added or skipped later.
  try {
    await writeFile(
      notePath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: created.ts,
        createdAtIso: created.tsIso,
        note,
      }, null, 2),
      'utf8',
    )
  } catch (err) {
    if (isMissingPathError(err)) {
      // Retention pruning can remove an old bundle while the note modal is
      // still open. Recreating the directory here would leave an empty folder
      // that looks like a real capture, so skip the late note instead.
      console.warn('[debug-bundle] skipped note for pruned bundle', params.bundlePath)
      return
    }
    throw err
  }
  try {
    await appendDebugBundleLogEntry(debugBundleLogFileForBundlePath(params.bundlePath), {
      schemaVersion: 1,
      event: 'note-added',
      ...created,
      bundlePath: resolve(params.bundlePath),
      note,
    })
  } catch (err) {
    // The note file was written into the bundle already. Keep the IPC result
    // successful for the same reason save entries are best-effort: the JSONL
    // is an index, not the user's durable artifact.
    console.warn('[debug-bundle] failed to append note index entry', err)
  }
}

function isMissingPathError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}
