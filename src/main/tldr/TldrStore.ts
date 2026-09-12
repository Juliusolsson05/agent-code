import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { normalizeTldrText, validTldrIdentity } from '@shared/types/tldr.js'
import type { TldrRecord, TldrUpdate } from '@shared/types/tldr.js'

const MAX_RECORDS = 10_000
const MAX_FILE_BYTES = 24 * 1024 * 1024

/** Main owns both MCP writes and renderer reads. A pane unmount, closed window,
 * or delayed workspace autosave must not discard an acknowledged update. The
 * opaque identity is carried by workspace metadata across the operations that
 * preserve a conversation; it is deliberately independent of PTY routing IDs. */
export class TldrStore extends EventEmitter {
  private records: Record<string, TldrRecord> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string, private readonly now = () => new Date()) { super() }

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
      this.emit('changed', { identity, record: { ...record } } satisfies TldrUpdate)
      return { ...record }
    })
  }
}
