import { ControlError, type AgentReadInput, type AgentReadOutput } from '@control-sdk'
import type { ProjectedMessage } from './projectConversation'

export type ReadMetadata = Omit<AgentReadOutput, 'messages' | 'deletedMessageIds' | 'nextCursor' | 'deltaCursor' | 'olderCursor' | 'hasMore' | 'snapshotId'>
export type ReadSnapshot = {
  id: string; identity: string; createdAt: number; metadata: ReadMetadata; rows: ProjectedMessage[]
  basis: ProjectedMessage[]; deleted: string[]; older: string | null; completed: boolean
  deltaBaseId?: string
}

// Cursors address an immutable read snapshot, not a live array index. Streaming
// while a long message is paged cannot splice two revisions together. Expired
// snapshots explicitly reset; they never silently reinterpret the offset.
export function createReadSnapshots() {
  const snapshots = new Map<string, ReadSnapshot>()
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const prune = () => {
    for (const [id, snapshot] of snapshots) if (Date.now() - snapshot.createdAt > 300_000) snapshots.delete(id)
    if (snapshots.size) expiryTimer = setTimeout(prune, 60_000)
    else expiryTimer = undefined
  }
  const get = (id: string, identity: string, depth: string) => {
    const snapshot = snapshots.get(id)
    if (!snapshot || snapshot.identity !== identity || snapshot.metadata.depth !== depth || Date.now() - snapshot.createdAt > 300_000) {
      throw new ControlError('stale_cursor', 'Read snapshot expired or the agent/provider/compaction boundary changed; start a fresh read')
    }
    return snapshot
  }
  return {
    get,
    create(input: Omit<ReadSnapshot, 'id' | 'createdAt' | 'completed'>): ReadSnapshot {
      while (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!)
      const snapshot = { ...input, id: crypto.randomUUID(), createdAt: Date.now(), completed: false }
      snapshots.set(snapshot.id, snapshot)
      if (!expiryTimer) expiryTimer = setTimeout(prune, 60_000)
      return snapshot
    },
    page(snapshot: ReadSnapshot, input: AgentReadInput): AgentReadOutput {
      let index = 0
      let offset = 0
      if (input.cursor) {
        const parts = input.cursor.split(':')
        if (parts.length !== 3 || parts[0] !== snapshot.id || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) throw new ControlError('invalid_cursor', 'Malformed read continuation')
        index = Number(parts[1]); offset = Number(parts[2])
      }
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index < 0 || index > snapshot.rows.length
        || offset < 0 || offset > (snapshot.rows[index]?.text.length ?? 0)) throw new ControlError('invalid_cursor', 'Read continuation is outside its snapshot')
      const messages: AgentReadOutput['messages'] = []
      let remaining = input.maxChars
      while (index < snapshot.rows.length && messages.length < input.maxMessages && remaining > 0) {
        const row = snapshot.rows[index]
        if (offset && /[\uDC00-\uDFFF]/.test(row.text[offset] ?? '') && /[\uD800-\uDBFF]/.test(row.text[offset - 1] ?? '')) throw new ControlError('invalid_cursor', 'Read offset splits a Unicode character')
        let end = Math.min(row.text.length, offset + remaining)
        if (end < row.text.length && /[\uD800-\uDBFF]/.test(row.text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(row.text[end] ?? '')) end--
        if (end === offset && row.text.length > offset) break
        messages.push({ ...row, text: row.text.slice(offset, end), offset, totalChars: row.text.length,
          nextOffset: end < row.text.length ? end : null })
        remaining -= end - offset
        if (end < row.text.length) { offset = end; break }
        index++; offset = 0
      }
      const nextCursor = index < snapshot.rows.length ? `${snapshot.id}:${index}:${offset}` : null
      if (!nextCursor) snapshot.completed = true
      return { ...snapshot.metadata, messages, deletedMessageIds: input.cursor ? [] : snapshot.deleted,
        nextCursor, snapshotId: snapshot.id, deltaCursor: nextCursor ? null : snapshot.deltaBaseId ?? snapshot.id,
        olderCursor: nextCursor ? null : snapshot.older, hasMore: Boolean(nextCursor || snapshot.older) }
    },
    dispose() { if (expiryTimer) clearTimeout(expiryTimer); snapshots.clear() },
  }
}

export function changedMessages(previous: ProjectedMessage[], current: ProjectedMessage[]) {
  const before = new Map(previous.map(message => [message.id, message]))
  const after = new Set(current.map(message => message.id))
  const rows = current.filter(message => {
    const prior = before.get(message.id)
    return !prior || prior.text !== message.text || prior.partial !== message.partial || prior.source !== message.source || prior.phase !== message.phase || prior.timestamp !== message.timestamp || JSON.stringify(prior.attachments) !== JSON.stringify(message.attachments)
  })
  // Committed records falling outside the live entry window are still in
  // history. Only remove transient owners; a true rewind/replacement resets the
  // identity boundary instead of pretending viewport eviction deleted history.
  const deleted = previous.filter(message => !after.has(message.id) && message.source !== 'committed').map(message => message.id)
  if (deleted.length > 200) throw new ControlError('stale_cursor', 'The live projection changed substantially; read a fresh snapshot')
  return { rows, deleted }
}
