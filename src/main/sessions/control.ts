import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { ControlError, defineCapability, transcriptPageInput, transcriptPageOutput } from '@control-sdk'
import { resolveProviderTranscriptPath } from '@main/providerSwitch/shared'
import { getToolPath } from '@main/setup/toolchain'
import { exportOpencodeSession } from '@providers/opencode/runtime/opencodeCliSessions'
import { HistoryCursorChangedError, loadInitialHistoryChunkFromFile, loadOlderHistoryChunkFromFile } from './historyLoader'
import type { z } from 'zod'

type Request = z.infer<typeof transcriptPageInput>
type Cursor = { identity: string; expires: number } & (
  | { source: 'provider-file'; path: string; fileIdentity: string; size: number; offset: number; hash: string }
  | { source: 'provider-export'; entries: Record<string, unknown>[]; end: number; exportId: string }
)

// This feature adapts the existing provider storage operations to the SDK.
// Neither the SDK nor the external MCP adapter learns transcript directories,
// database schemas, or provider CLI syntax. Exports are immutable read snapshots;
// file cursors require the same inode and exact record at their byte boundary.
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
    description: 'SDK backing operation for agent reads. Reads exact provider file windows or a supported OpenCode export without waking an agent. Opaque cursors expire and reject changed transcript boundaries.',
    input: transcriptPageInput, output: transcriptPageOutput,
    handler: async request => {
      const key = identity(request)
      const previous = request.cursor ? cursors.get(request.cursor) : undefined
      if (request.cursor && (!previous || previous.identity !== key || previous.expires < Date.now())) {
        throw new ControlError('stale_cursor', 'History cursor expired or belongs to another transcript')
      }
      const expires = Date.now() + 5 * 60_000
      if (request.provider === 'opencode') {
        if (previous && previous.source !== 'provider-export') throw new ControlError('invalid_cursor', 'Wrong history source')
        let entries: Record<string, unknown>[]
        let exportId: string
        if (previous) { entries = previous.entries; exportId = previous.exportId }
        else {
          const exported = await exportOpencodeSession({ binary: getToolPath('opencode', 'opencode'), cwd: request.cwd }, request.providerSessionId)
          const info = exported.info as Record<string, unknown> | undefined
          if (info?.id !== request.providerSessionId || !Array.isArray(exported.messages)) throw new ControlError('unavailable', 'OpenCode export did not match the requested session')
          entries = exported.messages as Record<string, unknown>[]
          exportId = randomUUID()
        }
        const end = previous?.end ?? entries.length
        const start = Math.max(0, end - request.maxRecords)
        return { entries: transcriptPageOutput.shape.entries.parse(entries.slice(start, end)), source: 'provider-export' as const, sourceIdentity: exportId,
          olderCursor: start > 0 ? save({ source: 'provider-export', identity: key, expires, entries, end: start, exportId }) : null }
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
