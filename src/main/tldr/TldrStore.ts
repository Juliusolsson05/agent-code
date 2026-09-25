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
  /** The last revision of each record set aside at load (#1247 review A):
   *  every reader keeps the HIGHER revision when a read and a change event
   *  race, so an identity that reports again after its record was set aside
   *  must continue above it, not restart at 1 and be discarded as stale. */
  private readonly setAsideRevisions = new Map<string, number>()
  /** The loaded file's bytes while set-aside records are not yet preserved.
   *  The next write drops them from the file, so it must not run until a
   *  copy exists; it retries the copy and is refused if it still fails. */
  private unpreserved: { source: string; setAside: number } | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private historyFileCount: number | null = null

  // WHY history lives in one small file per identity rather than beside the
  // current records: every accepted update rewrites its document atomically.
  // One shared history document would reach megabytes across thousands of
  // agents and be rewritten in full on each agent's every update.
  private readonly historyDirectory: string

  private readonly maxHistoryFiles: number

  private readonly label: string

  /**
   * The Goal capability (#936) is a second instance rather than a second store
   * class: goals need exactly these guarantees — one serialized atomic writer,
   * revocation re-checked after I/O, bounded per-identity history — and a copy
   * would drift the first time one of them is fixed. `historyDirectoryName`
   * keeps the two histories apart on disk; `label` names the capability in the
   * errors an agent reads.
   */
  constructor(
    private readonly file: string,
    private readonly now = () => new Date(),
    options: { maxHistoryFiles?: number; historyDirectoryName?: string; label?: string } = {},
  ) {
    super()
    this.historyDirectory = join(dirname(file), options.historyDirectoryName ?? 'tldr-history')
    this.maxHistoryFiles = options.maxHistoryFiles ?? MAX_HISTORY_FILES
    this.label = options.label ?? 'TLDR'
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
    // WHY an invalid RECORD is set aside instead of refusing the store (#1247):
    // the refusal was never cached as a result, so every read and write
    // re-failed. Every agent's tldr_update and goal_set then failed, the peeks
    // and Agent Activity went empty, and the enforcement hooks threw, all for
    // one record, typically one a newer build with a larger text limit wrote
    // before a downgrade (the owner's real file already has a record at
    // exactly today's 400-char limit). The file's rule is still "refuse and
    // preserve rather than guess": the record is not repaired, its identity
    // simply has no current record, and the original bytes are preserved
    // beside the file before any write can drop it. A malformed CONTAINER
    // above still refuses, since writing through it would destroy every record.
    let setAside = 0
    for (const [identity, raw] of Object.entries(document.records)) {
      const record = raw as TldrRecord
      if (!validTldrIdentity(identity) || !record || typeof record.text !== 'string'
        || !storedTextValid(record.text)
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
        || !validCompletion(record)) {
        setAside++
        const revision = (raw as { revision?: unknown } | null)?.revision
        if (validTldrIdentity(identity) && Number.isSafeInteger(revision) && (revision as number) >= 1) {
          this.setAsideRevisions.set(identity, revision as number)
        }
        continue
      }
      // Rebuilt field by field, as before: whatever else a hand edit or a newer
      // build left in the file does not survive into memory. The completion
      // pair is copied only when present, so records written before #1182
      // round-trip byte-identically.
      records[identity] = {
        text: record.text, updatedAt: record.updatedAt, revision: record.revision,
        ...(record.completedAt !== undefined
          ? { completedAt: record.completedAt, completionNote: record.completionNote }
          : {}),
      }
    }
    if (setAside > 0) {
      // A failed copy must not fail the READ (#1257 review B): a read drops
      // nothing, and failing it would bring back #1247's symptom (every peek
      // empty) on exactly the full or read-only disks this has to survive.
      // The copy is owed before the first write instead; see commit().
      this.unpreserved = { source, setAside }
      await this.preserveOwedCopy().catch(error => {
        console.warn(`[${this.label.toLowerCase()}] could not preserve ${setAside} invalid record(s) yet; writes wait for it:`, error)
      })
    }
    this.records = records
    return records
  }

  /** Byte-for-byte copy of a file whose records were set aside. Named by the
   *  content digest so relaunching over the same bytes, before any write
   *  replaces them, does not pile up identical copies. */
  private async preserveOwedCopy(): Promise<void> {
    if (!this.unpreserved) return
    const { source, setAside } = this.unpreserved
    const copy = await preserveBytes(`${this.file}.invalid`, source)
    this.unpreserved = null
    console.warn(`[${this.label.toLowerCase()}] set aside ${setAside} invalid record(s); original preserved at ${copy}`)
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

  /** When this identity's current record was marked complete (#1182), for the
   * prompt-time nudge that asks a completed agent given more work to set a new
   * goal. Undefined for an incomplete or missing record. */
  completedAt(identity: string): Promise<string | undefined> {
    return this.serialize(async () => {
      if (!validTldrIdentity(identity)) throw new Error('Invalid TLDR identity.')
      return (await this.load())[identity]?.completedAt
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

  private async appendHistory(identity: string, entry: TldrHistoryEntry): Promise<void> {
    const path = this.historyFile(identity)
    // Whether this adds a file is a question about the directory, not about
    // whether the old contents parsed. Repairing a corrupt file must not count
    // as a new one, or the eviction below would delete real histories.
    const existed = await stat(path).then(() => true, () => false)
    // An unreadable history (for example one entry a newer build wrote over
    // today's limit) used to read as EMPTY here, and the rename below then
    // replaced that identity's whole timeline with one entry (#1247 review
    // A). Its bytes are preserved first, and every entry that still
    // validates is carried forward.
    const previous = existed
      ? await this.readHistory(identity).catch(async () => {
        const raw = await readFile(path, 'utf8').catch(() => null)
        if (raw === null) return []
        // No `.json` extension: history eviction counts and deletes every
        // `*.json` in this directory, and preserved evidence is neither.
        const copy = await preserveBytes(`${path}.invalid`, raw, '')
        console.warn(`[${this.label.toLowerCase()}] history for one identity was unreadable; original preserved at ${copy}`)
        return salvageHistory(raw, identity)
      })
      : []
    // An agent re-posting an unchanged status is not a new moment in the task;
    // keeping it would bury real transitions under identical rows. The KIND
    // matters too (#1182), for the one case where a completion row and a goal
    // row carry identical text: an agent completing with its goal's own words
    // as the note, or setting a goal worded exactly like the note it just
    // completed with. Comparing text alone would swallow that transition.
    if (previous[0]?.text === entry.text && Boolean(previous[0]?.completed) === Boolean(entry.completed)) return
    const entries = [entry, ...previous].slice(0, TLDR_HISTORY_LIMIT)
    await mkdir(this.historyDirectory, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, identity, entries }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    if (!existed) await this.evictOldHistory()
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
    // The cached count only decides whether to look. The directory listing is
    // the truth, and the excess is clamped: a negative end index to slice()
    // would select every file except the newest few and delete them.
    const excess = Math.max(0, aged.length - this.maxHistoryFiles)
    for (const { path } of aged.slice(0, excess)) await unlink(path).catch(() => {})
    this.historyFileCount = aged.length - excess
  }

  update(identity: string, value: string, authorized: () => boolean): Promise<TldrRecord> {
    return this.serialize(async () => {
      if (!validTldrIdentity(identity)) throw new Error('Invalid TLDR identity.')
      const text = normalizeTldrText(value, this.label)
      const records = await this.load()
      if (!authorized()) throw new Error(`This ${this.label} session is no longer active.`)
      if (!records[identity] && Object.keys(records).length >= MAX_RECORDS) throw new Error('TLDR storage is full.')
      // A fresh record, deliberately WITHOUT any completion carried over: for
      // the Goal store this is how a new goal clears the old one's completion
      // (#1182). The agent sets a new goal exactly when it is given new work.
      const previousRevision = records[identity]?.revision ?? this.setAsideRevisions.get(identity) ?? 0
      const record: TldrRecord = { text, updatedAt: this.now().toISOString(), revision: previousRevision + 1 }
      await this.commit(identity, records, record, authorized)
      // The current record is already durable and acknowledged. History is the
      // secondary view of it, so a history failure (a full disk, a corrupt file)
      // must not turn a successful report into a failed tool call that the
      // agent would retry.
      await this.appendHistory(identity, { text: record.text, writtenAt: record.updatedAt, revision: record.revision })
        .catch(error => { console.warn('[tldr] history append failed:', error) })
      this.emit('changed', { identity, record: { ...record } } satisfies TldrUpdate)
      return { ...record }
    })
  }

  /**
   * Mark the current record complete (#1182; only the Goal store calls this).
   *
   * WHY it refuses without a record: completion is a claim ABOUT a goal. With
   * nothing set, the user's close menu would list an agent as "done" without
   * saying what it did, which is the one thing the list exists to show.
   *
   * WHY the revision bumps although `text` does not change: every reader
   * (overlay, history modal, remote frames) keeps the higher revision when a
   * disk read and a change event race. Without the bump, a slow read taken
   * just before completion would win and hide it.
   *
   * Completing again replaces the note and time. That is idempotent in the
   * sense the tool annotation promises — the record ends in the state the
   * latest call asked for — and lets an agent correct a bad summary.
   */
  complete(identity: string, value: string, authorized: () => boolean): Promise<TldrRecord> {
    return this.serialize(async () => {
      if (!validTldrIdentity(identity)) throw new Error('Invalid TLDR identity.')
      const note = normalizeTldrText(value, `${this.label} completion`)
      const records = await this.load()
      if (!authorized()) throw new Error(`This ${this.label} session is no longer active.`)
      const current = records[identity]
      if (!current) throw new Error(`Set a ${this.label.toLowerCase()} with goal_set before completing it.`)
      const completedAt = this.now().toISOString()
      const record: TldrRecord = {
        text: current.text, updatedAt: current.updatedAt, revision: current.revision + 1,
        completedAt, completionNote: note,
      }
      await this.commit(identity, records, record, authorized)
      await this.appendHistory(identity, { text: note, writtenAt: completedAt, revision: record.revision, completed: true })
        .catch(error => { console.warn('[tldr] history append failed:', error) })
      this.emit('changed', { identity, record: { ...record } } satisfies TldrUpdate)
      return { ...record }
    })
  }

  /** The one durable write both mutations share: temp file, revocation
   * re-checked after the I/O, atomic rename, then the in-memory swap. Kept in
   * one place so a guarantee fixed for `update` cannot be missing from
   * `complete`. Must run inside `serialize`. */
  private async commit(
    identity: string,
    records: Record<string, TldrRecord>,
    record: TldrRecord,
    authorized: () => boolean,
  ): Promise<void> {
    // Writing now would drop set-aside records whose bytes are not yet
    // preserved anywhere; the copy is retried, and the write refused if it
    // still cannot be made.
    await this.preserveOwedCopy()
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
      if (!authorized()) throw new Error(`This ${this.label} session is no longer active.`)
      await rename(temporary, this.file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    this.records = next
  }
}

/** Completion is all-or-nothing: a time without a note (or the reverse) is not
 * something this store ever writes, so it can only be damage. Rejecting it
 * follows the file's existing rule — refuse and preserve rather than guess. */
function validCompletion(record: TldrRecord): boolean {
  if (record.completedAt === undefined && record.completionNote === undefined) return true
  return typeof record.completedAt === 'string' && Number.isFinite(Date.parse(record.completedAt))
    && typeof record.completionNote === 'string' && storedTextValid(record.completionNote)
}

/** Write `bytes` to `<prefix>-<digest>.json` exactly once, atomically.
 *
 *  WHY temp + rename and a byte comparison (#1247 review A): a crash in a
 *  direct write left an empty or partial copy under the final name, and
 *  "the name already exists" was then taken as proof the evidence was safe,
 *  while the next write dropped the original record. An existing copy counts
 *  only if its bytes are identical; anything else gets a fresh name. */
async function preserveBytes(prefix: string, bytes: string, extension = '.json'): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  let copy = `${prefix}-${digest}${extension}`
  const existing = await readFile(copy, 'utf8').catch(() => null)
  if (existing === bytes) return copy
  if (existing !== null) copy = `${prefix}-${digest}-${randomUUID()}${extension}`
  const temporary = `${copy}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temporary, copy)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return copy
}

/** The entries of an unreadable history document that still validate, in
 *  order, when the document is at least the right identity's list. */
function salvageHistory(raw: string, identity: string): TldrHistoryEntry[] {
  try {
    const document = JSON.parse(raw) as { version?: unknown; identity?: unknown; entries?: unknown }
    if (document.version !== 1 || document.identity !== identity || !Array.isArray(document.entries)) return []
    return document.entries.filter(validHistoryEntry).slice(0, TLDR_HISTORY_LIMIT)
  } catch {
    return []
  }
}

/** Whether stored text is exactly what this build would have written.
 *  normalizeTldrText THROWS for text it rejects (over the limit, empty), which
 *  is right for a new update and wrong for validating a stored record: the
 *  throw escaped the per-record check and failed the whole store (#1247). */
function storedTextValid(text: string): boolean {
  try {
    return normalizeTldrText(text) === text
  } catch {
    return false
  }
}

function validHistoryEntry(value: unknown): value is TldrHistoryEntry {
  const entry = value as TldrHistoryEntry
  return Boolean(entry) && typeof entry.text === 'string' && storedTextValid(entry.text)
    && typeof entry.writtenAt === 'string' && Number.isFinite(Date.parse(entry.writtenAt))
    && Number.isSafeInteger(entry.revision) && entry.revision >= 1
    && (entry.completed === undefined || entry.completed === true)
}
