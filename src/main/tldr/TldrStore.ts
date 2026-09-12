import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { normalizeTldrText, TLDR_HISTORY_LIMIT, validTldrIdentity } from '@shared/types/tldr.js'
import type { TldrHistoryEntry, TldrRecord, TldrUpdate } from '@shared/types/tldr.js'

const MAX_RECORDS = 10_000
const MAX_FILE_BYTES = 24 * 1024 * 1024
// Every agent that ever reported keeps a history file, and closed agents are
// never told to the store. Bounding the file count keeps the directory from
// growing without limit; evicting the least recently written keeps the agents a
// user is actually looking at.
const MAX_HISTORY_FILES = 2_000
const MAX_HISTORY_FILE_BYTES = 512 * 1024

/** Main owns both MCP writes and renderer reads. A pane unmount, closed window,
 * or delayed workspace autosave must not discard an acknowledged update. The
 * opaque identity is carried by workspace metadata across the operations that
 * preserve a conversation; it is deliberately independent of PTY routing IDs. */
export class TldrStore extends EventEmitter {
  private records: Record<string, TldrRecord> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private historyFileCount: number | null = null

  // WHY history lives in one small file per identity rather than beside the
  // current records: every accepted update rewrites its document atomically.
  // One shared history document would reach megabytes across thousands of
  // agents and be rewritten in full on each agent's every update.
  private readonly historyDirectory: string

  private readonly maxHistoryFiles: number

  constructor(
    private readonly file: string,
    private readonly now = () => new Date(),
    options: { maxHistoryFiles?: number } = {},
  ) {
    super()
    this.historyDirectory = join(dirname(file), 'tldr-history')
    this.maxHistoryFiles = options.maxHistoryFiles ?? MAX_HISTORY_FILES
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  private async load(): Promise<Record<string, TldrRecord>> {
    if (this.records) return this.records
    let source: string
    try {
      if ((await stat(this.file)).size > MAX_FILE_BYTES) throw new Error('TLDR storage exceeds its size limit.')
      source = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.records = Object.create(null) as Record<string, TldrRecord>
      return this.records
    }
    const document = JSON.parse(source)
    if (document?.version !== 1 || !document.records || typeof document.records !== 'object'
      || Array.isArray(document.records) || Object.keys(document.records).length > MAX_RECORDS) {
      throw new Error('TLDR storage is invalid; the original file has been preserved.')
    }
    const records = Object.create(null) as Record<string, TldrRecord>
    for (const [identity, raw] of Object.entries(document.records)) {
      const record = raw as TldrRecord
      if (!validTldrIdentity(identity) || !record || typeof record.text !== 'string'
        || normalizeTldrText(record.text) !== record.text
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
        throw new Error('TLDR storage is invalid; the original file has been preserved.')
      }
      records[identity] = { text: record.text, updatedAt: record.updatedAt, revision: record.revision }
    }
    this.records = records
    return records
  }

  read(identities: string[]): Promise<Record<string, TldrRecord>> {
    return this.serialize(async () => {
      if (identities.length > MAX_RECORDS || !identities.every(validTldrIdentity)) throw new Error('Invalid TLDR identities.')
      const records = await this.load()
      return Object.fromEntries(identities.filter(id => records[id]).map(id => [id, { ...records[id]! }]))
    })
  }

  /** When this identity last reported, for turn-end enforcement. Deliberately
   * the store's own write time rather than anything the agent says. */
  lastWrittenAt(identity: string): Promise<string | undefined> {
    return this.serialize(async () => {
      if (!validTldrIdentity(identity)) throw new Error('Invalid TLDR identity.')
      return (await this.load())[identity]?.updatedAt
    })
  }

  /** Newest first. An unreadable history file reports failure instead of
   * pretending the agent never reported, which would read as a missed update. */
  history(identity: string): Promise<TldrHistoryEntry[]> {
    return this.serialize(async () => (await this.readHistory(identity)).map(entry => ({ ...entry })))
  }

  private historyFile(identity: string): string {
    // Identities may contain ':' — legal on macOS and Linux but not Windows —
    // and are opaque to users anyway. A hash is a portable, fixed-length name;
    // the identity is stored inside and checked on read.
    return join(this.historyDirectory, `${createHash('sha256').update(identity).digest('hex')}.json`)
  }

  private async readHistory(identity: string): Promise<TldrHistoryEntry[]> {
    if (!validTldrIdentity(identity)) throw new Error('Invalid TLDR identity.')
    let source: string
    try {
      const path = this.historyFile(identity)
      if ((await stat(path)).size > MAX_HISTORY_FILE_BYTES) throw new Error('TLDR history is invalid.')
      source = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const document = JSON.parse(source)
    const entries: unknown = document?.entries
    if (document?.version !== 1 || document.identity !== identity || !Array.isArray(entries)
      || entries.length > TLDR_HISTORY_LIMIT || !entries.every(validHistoryEntry)) {
      throw new Error('TLDR history is invalid.')
    }
    return entries as TldrHistoryEntry[]
  }

  private async appendHistory(identity: string, record: TldrRecord): Promise<void> {
    const previous = await this.readHistory(identity).catch(() => [])
    // An agent re-posting an unchanged status is not a new moment in the task;
    // keeping it would bury real transitions under identical rows.
    if (previous[0]?.text === record.text) return
    const entries = [{ text: record.text, writtenAt: record.updatedAt, revision: record.revision }, ...previous]
      .slice(0, TLDR_HISTORY_LIMIT)
    const path = this.historyFile(identity)
    const isNew = previous.length === 0
    await mkdir(this.historyDirectory, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, identity, entries }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    if (isNew) await this.evictOldHistory()
  }

  private async evictOldHistory(): Promise<void> {
    if (this.historyFileCount === null) {
      this.historyFileCount = (await readdir(this.historyDirectory)).filter(name => name.endsWith('.json')).length
    } else {
      this.historyFileCount += 1
    }
    if (this.historyFileCount <= this.maxHistoryFiles) return
    const names = (await readdir(this.historyDirectory)).filter(name => name.endsWith('.json'))
    const aged = await Promise.all(names.map(async name => {
      const path = join(this.historyDirectory, name)
      return { path, mtime: (await stat(path).catch(() => null))?.mtimeMs ?? 0 }
    }))
    aged.sort((a, b) => a.mtime - b.mtime)
    for (const { path } of aged.slice(0, aged.length - this.maxHistoryFiles)) await unlink(path).catch(() => {})
    this.historyFileCount = Math.min(aged.length, this.maxHistoryFiles)
  }

  update(identity: string, value: string, authorized: () => boolean): Promise<TldrRecord> {
    return this.serialize(async () => {
      if (!validTldrIdentity(identity)) throw new Error('Invalid TLDR identity.')
      const text = normalizeTldrText(value)
      const records = await this.load()
      if (!authorized()) throw new Error('This TLDR session is no longer active.')
      if (!records[identity] && Object.keys(records).length >= MAX_RECORDS) throw new Error('TLDR storage is full.')
      const record = { text, updatedAt: this.now().toISOString(), revision: (records[identity]?.revision ?? 0) + 1 }
      // Preserve the null prototype after every write, not just initial load.
      // Otherwise a valid opaque key such as "constructor" can read inherited
      // object properties and persist an invalid revision instead of entry 1.
      const next = Object.assign(Object.create(null) as Record<string, TldrRecord>, records, { [identity]: record })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, records: next }), { mode: 0o600, flag: 'wx' })
        // Recheck after disk I/O: a queued old-provider request may outlive a
        // reload. Revocation is the boundary, not possession of an old token.
        if (!authorized()) throw new Error('This TLDR session is no longer active.')
        await rename(temporary, this.file)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      this.records = next
      // The current record is already durable and acknowledged. History is the
      // secondary view of it, so a history failure (a full disk, a corrupt file)
      // must not turn a successful report into a failed tool call that the
      // agent would retry.
      await this.appendHistory(identity, record).catch(error => {
        console.warn('[tldr] history append failed:', error)
      })
      this.emit('changed', { identity, record: { ...record } } satisfies TldrUpdate)
      return { ...record }
    })
  }
}

function validHistoryEntry(value: unknown): value is TldrHistoryEntry {
  const entry = value as TldrHistoryEntry
  return Boolean(entry) && typeof entry.text === 'string' && normalizeTldrText(entry.text) === entry.text
    && typeof entry.writtenAt === 'string' && Number.isFinite(Date.parse(entry.writtenAt))
    && Number.isSafeInteger(entry.revision) && entry.revision >= 1
}
