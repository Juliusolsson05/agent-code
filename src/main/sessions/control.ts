import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { ControlError, defineCapability, transcriptPageInput, transcriptPageOutput } from '@control-sdk'
import { resolveProviderTranscriptPath } from '@main/providerSwitch/shared'
import { getMainProvider } from '@providers/registry.main'
import { HistoryCursorChangedError, loadInitialHistoryChunkFromFile, loadOlderHistoryChunkFromFile } from './historyLoader'
import type { z } from 'zod'

type Request = z.infer<typeof transcriptPageInput>
type Cursor = { identity: string; expires: number } & (
  | { source: 'provider-file'; path: string; fileIdentity: string; size: number; offset: number; hash: string }
  | { source: 'provider-history'; marker: string; sourceIdentity: string }
)

// This feature adapts the existing provider storage operations to the SDK.
// Neither the SDK nor the external MCP adapter learns transcript directories,
// database schemas, or provider CLI syntax. File cursors require the same inode
// and exact record at their byte boundary. Provider cursors retain only a native
// marker, not a whole-session export: each older request reads a bounded window
// from the current projection, including the provider's revert behavior.
export function sessionHistoryControlCapabilities() {
  const cursors = new Map<string, Cursor>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const prune = () => {
    for (const [key, cursor] of cursors) if (cursor.expires < Date.now()) cursors.delete(key)
    timer = cursors.size ? setTimeout(prune, 60_000) : undefined
    timer?.unref()
  }
  const save = (cursor: Cursor) => {
    if (!timer) { timer = setTimeout(prune, 60_000); timer.unref() }
    for (const [key, value] of cursors) if (value.expires < Date.now()) cursors.delete(key)
    while (cursors.size >= 128) cursors.delete(cursors.keys().next().value!)
    const id = randomUUID()
    cursors.set(id, cursor)
    return id
  }
  const identity = (request: Request) => JSON.stringify([request.provider, request.cwd, request.providerSessionId])
  return [defineCapability({
    id: 'transcripts.page', visibility: 'application', title: 'Read provider history window', execution: 'main', effect: 'read',
    description: 'SDK backing operation for agent reads. Reads exact provider file windows or provider-owned history pages without waking an agent. Opaque cursors expire and remain bound to the requested transcript.',
    input: transcriptPageInput, output: transcriptPageOutput,
    handler: async request => {
      const key = identity(request)
      const previous = request.cursor ? cursors.get(request.cursor) : undefined
      if (request.cursor && (!previous || previous.identity !== key || previous.expires < Date.now())) {
        throw new ControlError('stale_cursor', 'History cursor expired or belongs to another transcript')
      }
      const expires = Date.now() + 5 * 60_000
      const provider = getMainProvider(request.provider)
      if (provider.loadHistoryChunk) {
        if (previous && previous.source !== 'provider-history') throw new ControlError('stale_cursor', 'History source changed')
        // Identity describes the native session, not an export snapshot. A
        // revert may remove the marker row; the provider owns continuing from
        // the next older record. The cache retains only this opaque boundary,
        // so 128 callers asking for one row cannot pin 128 full transcripts.
        const sourceIdentity = provider.transcriptLocator?.(request.providerSessionId) ?? key
        if (previous && previous.sourceIdentity !== sourceIdentity) throw new ControlError('stale_cursor', 'History source changed')
        let chunk
        try {
          chunk = await provider.loadHistoryChunk({
            cwd: request.cwd, providerSessionId: request.providerSessionId, limit: request.maxRecords,
            ...(previous ? { beforeMarker: previous.marker } : {}),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null
          throw new ControlError('unavailable', code && !message.includes(code) ? `${code}: ${message}` : message)
        }
        const marker = chunk.oldestMarker
        if (chunk.hasMore && (!marker || marker === previous?.marker || !chunk.entries.length)) {
          throw new ControlError('unavailable', 'Provider history did not supply an advancing page marker')
        }
        return { entries: transcriptPageOutput.shape.entries.parse(chunk.entries), source: 'provider-history' as const, sourceIdentity,
          olderCursor: chunk.hasMore ? save({ source: 'provider-history', identity: key, expires, marker: marker!, sourceIdentity }) : null }
      }
      if (previous && previous.source !== 'provider-file') throw new ControlError('invalid_cursor', 'Wrong history source')
      const path = previous?.path ?? await resolveProviderTranscriptPath({ kind: request.provider, cwd: request.cwd, providerSessionId: request.providerSessionId })
      if (!path) throw new ControlError('unavailable', 'No durable transcript was found')
      const before = await stat(path)
      const fileIdentity = `${before.dev}:${before.ino}`
      if (previous && (previous.fileIdentity !== fileIdentity || before.size < previous.size)) throw new ControlError('stale_cursor', 'Transcript was replaced or truncated')
      try {
        const chunk = previous
          ? await loadOlderHistoryChunkFromFile(path, { kind: request.provider, beforeMarker: '', beforeOffset: previous.offset,
            beforeRecordHash: previous.hash, limit: request.maxRecords })
          : await loadInitialHistoryChunkFromFile(path, request.maxRecords, true)
        const after = await stat(path)
        if (`${after.dev}:${after.ino}` !== fileIdentity || after.size < before.size) throw new ControlError('stale_cursor', 'Transcript changed during read')
        const first = chunk.entries[0]
        const offset = chunk.offsets?.[0]
        if (chunk.hasMore && (!first || offset === undefined || (previous && offset >= previous.offset))) throw new ControlError('stale_cursor', 'History pagination did not advance')
        return { entries: transcriptPageOutput.shape.entries.parse(chunk.entries), source: 'provider-file' as const, sourceIdentity: fileIdentity,
          olderCursor: chunk.hasMore ? save({ source: 'provider-file', identity: key, expires, path, fileIdentity,
            size: before.size, offset: offset!, hash: createHash('sha256').update(JSON.stringify(first)).digest('hex') }) : null }
      } catch (error) {
        if (error instanceof HistoryCursorChangedError) throw new ControlError('stale_cursor', error.message)
        throw error
      }
    },
  })]
}
