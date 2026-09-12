import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { historyEventSchema, type ControlHistory, type HistoryEvent, type HistoryWrite } from '@control-sdk'

// This journal deliberately does not use the diagnostic incident recorder:
// diagnostics are bounded and summarized, whereas operation history must keep
// exact prompts/results and survive restarts. Only the process holding the
// application's state-directory lock may write this directory.
export class FileControlHistory implements ControlHistory {
  private loaded?: Promise<HistoryEvent[]>
  private tail: Promise<unknown> = Promise.resolve()
  private poisoned = false
  constructor(private readonly directory: string) {}

  private load(): Promise<HistoryEvent[]> {
    return this.loaded ??= (async () => {
      await mkdir(join(this.directory, 'payloads'), { recursive: true, mode: 0o700 })
      let text: string
      try { text = await readFile(join(this.directory, 'events.jsonl'), 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      // Never silently truncate a partial tail. Its missing bytes might contain
      // the only evidence of a dispatched action. Preserve it for inspection
      // and block new calls until storage is repaired deliberately.
      if (text && !text.endsWith('\n')) throw new Error('Control history has an incomplete tail; original evidence was preserved')
      return text.split('\n').filter(Boolean).map((line, index) => {
        const event = historyEventSchema.parse(JSON.parse(line))
        if (event.sequence !== index + 1) throw new Error('Control history sequence is damaged')
        return event
      })
    })()
  }

  async events(): Promise<HistoryEvent[]> {
    await this.tail
    return (await this.load()).map(event => ({ ...event }))
  }

  append(write: HistoryWrite, payload?: unknown): Promise<HistoryEvent> {
    const next = this.tail.then(async () => {
      if (this.poisoned) throw new Error('Control history write failed; reopen before inspecting recovery')
      const events = await this.load()
      const payloadId = payload === undefined ? undefined : await this.putPayload(payload)
      const event = historyEventSchema.parse({ ...write, sequence: events.length + 1,
        ...(payloadId ? { payload: payloadId } : {}) })
      const file = await open(join(this.directory, 'events.jsonl'), 'a', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(event)}\n`)
        await file.sync()
      } catch (error) {
        this.poisoned = true
        throw error
      } finally { await file.close() }
      // Directory sync makes the first journal entry durable too. A successful
      // file fsync alone does not promise that its newly created name survives.
      await this.syncDirectory(this.directory)
      events.push(event)
      return { ...event }
    })
    this.tail = next.catch(() => { this.poisoned = true })
    return next
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid history payload digest')
    return join(this.directory, 'payloads', `${id}.json`)
  }

  private async putPayload(payload: unknown): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
    const id = createHash('sha256').update(bytes).digest('hex')
    const destination = this.path(id)
    try {
      const existing = await readFile(destination)
      if (!existing.equals(bytes)) throw new Error('Control payload digest mismatch')
      return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await rename(temporary, destination)
      await this.syncDirectory(join(this.directory, 'payloads'))
      return id
    } finally { await rm(temporary, { force: true }) }
  }

  async payload(id: string): Promise<unknown> {
    const bytes = await readFile(this.path(id))
    if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Control payload failed integrity check')
    return JSON.parse(bytes.toString('utf8'))
  }

  async chunk(id: string, offset: number, limit: number) {
    const path = this.path(id)
    const totalBytes = (await stat(path)).size
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes
      || !Number.isSafeInteger(limit) || limit < 4 || limit > 262144) throw new Error('Invalid history payload range')
    const file = await open(path, 'r')
    try {
      // Offsets are bytes, not JS string positions. Read one lookahead byte to
      // avoid splitting a UTF-8 codepoint and reject hand-authored mid-codepoint
      // cursors. Returned continuation offsets always round-trip losslessly.
      const buffer = Buffer.alloc(Math.min(limit + 1, totalBytes - offset))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (bytesRead && (buffer[0] & 0xc0) === 0x80) throw new Error('Offset splits a UTF-8 codepoint')
      let end = Math.min(limit, bytesRead)
      while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80) end--
      return { text: buffer.subarray(0, end).toString('utf8'), offset,
        nextOffset: offset + end < totalBytes ? offset + end : null, totalBytes, sha256: id }
    } finally { await file.close() }
  }
}
