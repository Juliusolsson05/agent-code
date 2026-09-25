import { constants } from 'node:fs'
import { link, mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodePiConversation, piSessionFileName } from 'agent-transcript-parser'
import type { ConversationDocument, PromptReference } from 'agent-transcript-parser'
import { piProcessCwd, resolvePiSessionDir, resolvePiSessionFile } from 'pi-terminal-headless'

import type { TranscriptPublication } from './transcriptEngine.js'

// Pi's side of the transcript engine: read a Pi session file into the neutral
// document (the parser's decoder owns every Pi semantic: active branch,
// compaction, context edits) and publish a projected one where
// `pi --session-id <id>` finds it.
//
// WHY the reads go through the FILE and never through the live bridge: every
// transform (switch, duplicate, rewind) needs the durable conversation, and the
// file is what pi itself resumes from. One limit follows from that: a live
// `/tree` move WITHOUT a summary changes pi's leaf without writing a row, so
// until the next row lands, a transform reads the branch pi would reopen after
// a restart, not the one on screen. The decoder takes an explicit leaf for
// the day a caller can supply the live one.

export interface PiTranscriptSnapshot {
  conversation: ConversationDocument
  prompts: PromptReference[]
}

/** The session file for `sessionId`, or null while pi has not written it yet. */
export async function locatePiTranscript(cwd: string, sessionId: string): Promise<string | null> {
  return resolvePiSessionFile({ env: process.env, cwd, sessionId })
}

export async function loadPiSnapshot(cwd: string, sessionId: string): Promise<PiTranscriptSnapshot> {
  const path = await locatePiTranscript(cwd, sessionId)
  // No file is a real Pi state, not an error: pi writes nothing until a
  // session's first reply completes (Stage 0 H1), yet the pane already has
  // its id, since Agent Code launches with --session-id. An empty document is
  // what the engine's callers expect of "no conversation yet". A switch
  // reports `source-empty` and replaces the pane, and a duplicate clones an
  // empty session.
  if (!path) return { conversation: { schemaVersion: 1, sourceProvider: 'pi', sourceSessionIds: [sessionId], entries: [] }, prompts: [] }
  return loadPiSnapshotAt(path, sessionId)
}

export async function loadPiSnapshotAt(path: string, sessionId?: string): Promise<PiTranscriptSnapshot> {
  const text = await readStablePiFile(path)
  // A destructive transform must not accept a half-written tail. Pi appends
  // one JSON line per row, so an unterminated last line is a row in flight.
  if (text && !text.endsWith('\n')) throw new Error('Pi transcript has an unterminated row; wait for the native writer')
  const records: Record<string, unknown>[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error(`Pi transcript ${path} has malformed JSON at physical line ${index}`) }
    records.push(value as Record<string, unknown>)
  }
  const headerId = records[0]?.type === 'session' ? records[0].id : undefined
  // The header, not the file name, is pi's identity (SessionManager.findById
  // reads headers). A file whose header names another session is not the
  // session the caller asked for, and switching it would move the wrong
  // conversation.
  if (sessionId !== undefined && headerId !== sessionId) throw new Error('Pi session header does not match the requested session')
  const conversation = decodePiConversation(records, typeof headerId === 'string' ? { sessionId: headerId } : {})
  const id = conversation.sourceSessionIds[0] ?? null
  // Rewind boundaries are the user's own prompts. A `!cmd` run also reaches
  // the model as a user turn, and the decoder keeps it as user context, but it
  // is not something the user would rewind to (the feed mapper keeps it out
  // of View Prompts for the same reason).
  const prompts: PromptReference[] = []
  for (const entry of conversation.entries) {
    const role = (entry.source.raw.message as { role?: unknown } | undefined)?.role
    if (entry.kind === 'message' && entry.role === 'user' && role === 'user') {
      prompts.push({ address: { provider: 'pi', line: entry.source.line, sessionId: id }, raw: entry.source.raw })
    }
  }
  return { conversation, prompts }
}

/**
 * Publish a projected Pi session. Returns the new file's path.
 *
 * WHY link() and not writeFile to the final name: pi discovers sessions by
 * listing `*.jsonl` and reading headers, so a partially written final name
 * is a corrupt session that pi might open. The rows go to a name pi ignores
 * (no `.jsonl` suffix) and are then linked into place, which fails rather than
 * overwrites if the name exists. The pending name is removed either way.
 */
export async function writeProjectedPiSession(cwd: string, publication: TranscriptPublication): Promise<string> {
  const [header, ...rows] = publication.values
  if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || typeof header.timestamp !== 'string') {
    throw new Error('Projected Pi session must start with a v3 session header')
  }
  const processCwd = await piProcessCwd(cwd)
  // pi compares header cwd with its own process.cwd() (the real path) when a
  // custom session dir is shared between projects.
  if (header.cwd !== processCwd) throw new Error('Projected Pi session cwd does not match the target cwd')
  if (rows.some(row => typeof row.id !== 'string' || !('parentId' in row))) throw new Error('Projected Pi rows must carry id and parentId')
  if (await locatePiTranscript(cwd, header.id)) throw new Error(`A Pi session ${header.id} already exists for this project`)
  const directory = await resolvePiSessionDir({ env: process.env, cwd })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, piSessionFileName(header.id, header.timestamp))
  const pending = `${path}.pending`
  await writeFile(pending, publication.values.map(value => JSON.stringify(value)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  try {
    await link(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
  return path
}

async function readStablePiFile(path: string): Promise<string> {
  // Same guards as the Grok reader: no symlink swap, no FIFO blocking the
  // main process, and a file that changed while it was read is retried by
  // the caller after the turn settles, never accepted half-old half-new.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw new Error('Pi session file is not a regular file')
    const text = await file.readFile('utf8')
    const after = await stat(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error('Pi transcript changed while reading; retry after the native turn settles')
    }
    return text
  } finally { await file.close() }
}
