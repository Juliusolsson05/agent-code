import { constants } from 'node:fs'
import { mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decodeGrokConversation, type ConversationDocument } from 'agent-transcript-parser'
import { decodeGrokConversationItem, parseGrokSummary, resolveGrokTranscriptPath, writeGrokChatHistory } from 'grok-code-headless'
import type { TranscriptPublication } from './transcriptEngine.js'

export async function writeProjectedGrokSession(cwd: string, publication: TranscriptPublication): Promise<string> {
  const summary = parseGrokSummary(JSON.stringify(publication.summary ?? null))
  const canonicalCwd = await realpath(cwd)
  if (await realpath(summary.info.cwd) !== canonicalCwd) throw new Error('Grok summary cwd does not match the target cwd')
  // The package resolver validates the UUID before it becomes a directory
  // component, and owns native realpath/RFC3986/GROK_HOME path semantics.
  const path = resolveGrokTranscriptPath(canonicalCwd, summary.info.id)
  if (summary.chat_format_version !== 1) throw new Error('Unsupported Grok chat format')
  if (publication.values.length === 0) throw new Error('Grok resume contains no projectable history')
  if (summary.num_chat_messages !== publication.values.length || summary.num_messages !== 0) throw new Error('Grok projection counter mismatch')
  const rows = publication.values.map(value => decodeGrokConversationItem(JSON.stringify(value)))
  const directory = dirname(path)
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
  // Exclusive directory creation is the ownership claim. Keep it OUTSIDE
  // rollback: an EEXIST failure belongs to another publisher/native session,
  // and deleting that directory would destroy the user's existing history.
  await mkdir(directory, { mode: 0o700 })
  try {
    await writeGrokChatHistory(path, rows)
    await writeFile(join(directory, 'updates.jsonl'), '', { flag: 'wx', mode: 0o600 })
    const pendingSummary = join(directory, 'summary.pending')
    await writeFile(pendingSummary, JSON.stringify({
      ...summary, info: { ...summary.info, cwd: canonicalCwd },
    }) + '\n', { flag: 'wx', mode: 0o600 })
    // Native discovery requires summary.json. Publish it atomically and last,
    // only after the complete history/update file set exists. There is no
    // fallible cleanup after this marker transfers ownership to native Grok.
    await rename(pendingSummary, join(directory, 'summary.json'))
    return path
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true }) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Grok publication failed and its unpublished directory could not be removed') }
    throw error
  }
}

export async function readGrokTranscript(cwd: string, sessionId: string): Promise<ConversationDocument> {
  const path = resolveGrokTranscriptPath(cwd, sessionId)
  const summary = parseGrokSummary(await readStableGrokFile(join(dirname(path), 'summary.json')))
  if (summary.info.id !== sessionId || await realpath(summary.info.cwd) !== await realpath(cwd)) throw new Error('Grok summary identity does not match the requested session')
  if (summary.chat_format_version !== 1) throw new Error('Unsupported Grok chat format')
  const text = await readStableGrokFile(path)
  // The headless tail reader intentionally buffers/drops an active tail. A
  // destructive switch/rewind snapshot cannot silently accept that prefix:
  // doing so could retire the source while its final record is still writing.
  if (text && !text.endsWith('\n')) throw new Error('Grok transcript has an unterminated record; wait for the native writer')
  const records = text.split('\n').filter(line => line.trim()).map(line => decodeGrokConversationItem(line).item)
  return decodeGrokConversation(records, { sessionId })
}

async function readStableGrokFile(path: string): Promise<string> {
  // O_NOFOLLOW rejects links, but a FIFO would block before fstat can reject
  // it unless open is nonblocking. Apply the same rule to metadata and rows.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw new Error('Grok session file is not a regular file')
    const text = await file.readFile('utf8')
    const after = await stat(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('Grok transcript changed while reading; retry after the native turn settles')
    }
    return text
  } finally { await file.close() }
}
