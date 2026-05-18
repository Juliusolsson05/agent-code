import { appendFile, mkdir, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

import { DEBUG_BUNDLE_DIR } from '@main/storage/paths.js'

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

function nowFields(now = Date.now()): { ts: number; tsIso: string } {
  return { ts: now, tsIso: new Date(now).toISOString() }
}

function isInsideDebugBundleDir(path: string): boolean {
  const root = resolve(DEBUG_BUNDLE_DIR)
  const target = resolve(path)
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function appendDebugBundleLogEntry(entry: DebugBundleLogEntry): Promise<void> {
  await mkdir(dirname(DEBUG_BUNDLE_LOG_FILE), { recursive: true })
  await appendFile(DEBUG_BUNDLE_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function appendDebugBundleSaved(params: {
  bundlePath: string
  sessionId: string
  kind?: string | null
  reason?: string | null
  cwd?: string | null
  providerSessionId?: string | null
}): Promise<void> {
  await appendDebugBundleLogEntry({
    schemaVersion: 1,
    event: 'saved',
    ...nowFields(),
    bundlePath: params.bundlePath,
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
  // shared with the bundle.
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
  await appendDebugBundleLogEntry({
    schemaVersion: 1,
    event: 'note-added',
    ...created,
    bundlePath: resolve(params.bundlePath),
    note,
  })
}
