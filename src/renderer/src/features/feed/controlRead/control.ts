import { ControlError, agentReadInput, agentReadOutput, defineCapability, transcriptPageOutput,
  type AgentReadInput, type AgentReadOutput } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime, type RuntimeRenderInput } from '@renderer/session-runtime/state'
import { DEFAULT_PROVIDER, isAgentProviderKind, type AgentProviderKind } from '@shared/types/providerKind'
import type { Entry } from '@shared/types/transcript'
import { getRendererProviderCapabilities, providerDurableEntryKind } from '@providers/registry.renderer.capabilities'
import { createConversationProjection, type ProjectedMessage } from './projectConversation'
import { changedMessages, createReadSnapshots, type ReadMetadata, type ReadSnapshot } from './readSnapshots'

type Archive = {
  identity: string; depth: AgentReadInput['depth']; createdAt: number; cursor: string
  sourceIdentity: string; runtime: RuntimeRenderInput; seen: Set<string>; baseline: ReadSnapshot; transientIds: string[]
  result?: Promise<ReadSnapshot>
}
const ordering = 'chronological within each window; olderCursor requests the preceding history window' as const

function mergeHistory(raw: Record<string, unknown>[], runtime: RuntimeRenderInput, provider: AgentProviderKind): RuntimeRenderInput {
  const mapper = getRendererProviderCapabilities(provider).createTranscriptEntryMapper()
  const liveIds = new Set(runtime.entries.flatMap(entry => entry.uuid ? [entry.uuid] : []))
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const record of raw) for (const entry of mapper.map(record).entries) {
    if (entry.uuid && (liveIds.has(entry.uuid) || seen.has(entry.uuid))) continue
    if (entry.uuid) seen.add(entry.uuid)
    entries.push(entry)
  }
  // The UI's normalized copy wins overlap, including provider attribution and
  // optimistic ownership. All ordering/suppression after this identity merge
  // still belongs to the normal ledger; no text-matching reconciliation here.
  return { ...runtime, entries: [...entries, ...runtime.entries] }
}

export function createAgentReadControl() {
  const snapshots = createReadSnapshots()
  const project = createConversationProjection()
  const archives = new Map<string, Archive>()
  const boundaries = new Map<string, { base: string; compact: string | null }>()
  let pruneTimer: ReturnType<typeof setTimeout> | undefined
  const prune = () => {
    for (const [key, archive] of archives) if (Date.now() - archive.createdAt > 300_000) archives.delete(key)
    if (archives.size) pruneTimer = setTimeout(prune, 60_000)
    else pruneTimer = undefined
  }
  const saveArchive = (archive: Omit<Archive, 'createdAt'>) => {
    while (archives.size >= 64) archives.delete(archives.keys().next().value!)
    const key = crypto.randomUUID()
    archives.set(key, { ...archive, createdAt: Date.now() })
    if (!pruneTimer) pruneTimer = setTimeout(prune, 60_000)
    return key
  }
  const current = (sessionId: string) => {
    const { workspaceState: state, workspaceRuntimes } = useAppStore.getState()
    const meta = state.sessions[sessionId] ?? state.buried.find(record => record.sessionId === sessionId)?.sessionMeta
    if (!meta || !isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)) throw new ControlError('unavailable', 'Agent no longer exists in this window')
    const provider = (meta.kind ?? DEFAULT_PROVIDER) as AgentProviderKind
    return { meta, provider, runtime: workspaceRuntimes[sessionId] ?? emptyRuntime() }
  }
  const identityOf = (sessionId: string, value: ReturnType<typeof current>) => {
    const { meta, provider, runtime } = value
    const base = JSON.stringify([sessionId, provider, meta.cwd, meta.providerRuntime, meta.providerSessionId, runtime.sessionRunId,
      runtime.pendingRewindUndo?.createdAt])
    const prior = boundaries.get(sessionId)
    const boundary = [...runtime.entries].reverse().find(entry => providerDurableEntryKind(entry, provider) === 'compact-boundary')
    // Ordinary entry-window eviction is not a compaction. Remember the last
    // observed boundary until native identity/run changes so scrolling cannot
    // invalidate an otherwise valid delta baseline.
    const compact = boundary?.uuid ?? (prior?.base === base ? prior.compact : null)
    if (boundaries.size >= 512 && !boundaries.has(sessionId)) boundaries.delete(boundaries.keys().next().value!)
    boundaries.set(sessionId, { base, compact })
    return JSON.stringify([base, compact])
  }
  const history = async (value: ReturnType<typeof current>, cursor?: string) => {
    const result = await window.api.controlInvoke({ capabilityId: 'transcripts.page', input: {
      provider: value.provider, cwd: value.meta.cwd, providerSessionId: value.meta.providerSessionId!, ...(cursor ? { cursor } : {}), maxRecords: 120,
    } })
    if (!result.ok) throw new ControlError(result.error.code, result.error.message, result.error.outcome)
    return transcriptPageOutput.parse(result.value)
  }
  const read = async (input: AgentReadInput): Promise<AgentReadOutput> => {
    if ([input.cursor, input.older, input.since].filter(Boolean).length > 1
      || (!input.cursor && !input.older && (input.range === 'delta') !== Boolean(input.since))
      || (input.afterMessageId && (input.cursor || input.older || input.since))) {
      throw new ControlError('invalid_input', 'Use one continuation: cursor, older, or range=delta with since. afterMessageId is for a fresh read only')
    }
    const value = current(input.sessionId)
    const { meta, provider, runtime } = value
    const metadata: ReadMetadata = {
      sessionId: input.sessionId, provider, providerSessionId: meta.providerSessionId ?? null, sessionRunId: runtime.sessionRunId,
      depth: input.depth, range: input.range, observedAt: Date.now(), ordering,
      status: { process: runtime.processStatus, activity: runtime.sessionStatus, transcript: runtime.transcriptStatus,
        inputReady: runtime.inputReady, exited: runtime.exited, conditions: Object.keys(runtime.conditions?.conditions ?? {}),
        queuedCount: runtime.queuedMessages.length, draftPresent: Boolean(runtime.draftInput || runtime.draftImages.length) },
      availability: meta.providerRuntime === 'terminal' ? 'native_terminal' : 'available',
      ...(meta.providerRuntime === 'terminal' ? { reason: 'Native terminal live output is available through computer use; this read contains durable history only.' } : {}),
    }
    // Status polling deliberately does not touch transcript storage, mapper,
    // ledger, cursor caches or agent wake. It stays cheap on a busy workspace.
    if (input.depth === 'status') {
      if (input.cursor || input.older || input.since) throw new ControlError('invalid_input', 'Status reads do not use history cursors')
      return { ...metadata, messages: [], deletedMessageIds: [], nextCursor: null, deltaCursor: null, olderCursor: null, hasMore: false, snapshotId: null }
    }
    const identity = identityOf(input.sessionId, value)
    if (input.cursor) return snapshots.page(snapshots.get(input.cursor.split(':')[0], identity, input.depth), input)
    if (input.older) {
      const archive = archives.get(input.older)
      if (!archive || archive.identity !== identity || archive.depth !== input.depth || Date.now() - archive.createdAt > 300_000) {
        throw new ControlError('stale_cursor', 'Older-history cursor expired or its agent/depth changed; start a fresh session read')
      }
      // A retried older cursor shares one immutable result. Advancing a shared
      // mutable "seen" set on every retry would silently lose history.
      archive.result ??= (async () => {
        const page = await history(value, archive.cursor)
        if (identityOf(input.sessionId, current(input.sessionId)) !== identity || page.sourceIdentity !== archive.sourceIdentity) throw new ControlError('stale_cursor', 'Agent or transcript changed during history read')
        const combined = mergeHistory(page.entries, archive.runtime, provider)
        const projected = project(combined, provider, input.sessionId, input.depth)
        const rows = projected.filter(row => !archive.seen.has(row.id))
        const visibleIds = new Set(projected.map(row => row.id))
        const deleted = archive.transientIds.filter(id => !visibleIds.has(id))
        const transientIds = archive.transientIds.filter(id => visibleIds.has(id))
        const seen = new Set([...archive.seen, ...rows.map(row => row.id)])
        const baseline = archive.baseline
        const snapshot = snapshots.create({ identity, metadata: { ...metadata, range: 'session' }, rows,
          basis: baseline.basis, deleted, older: null, deltaBaseId: baseline.id })
        if (page.olderCursor) snapshot.older = saveArchive({ ...archive, cursor: page.olderCursor, seen, transientIds, result: undefined })
        return snapshot
      })()
      return snapshots.page(await archive.result, input)
    }
    let renderInput: RuntimeRenderInput = runtime
    let older: string | null = null
    let sourceIdentity = ''
    // Live deltas stay in memory. Initial session reads establish a durable
    // history cursor; cold reads use the same provider mappers as the UI's
    // history loader, without writing into the UI's scroll/runtime state.
    if (meta.providerSessionId && (!input.since || !runtime.entries.length)) {
      try {
        const page = await history(value)
        if (identityOf(input.sessionId, current(input.sessionId)) !== identity) throw new ControlError('stale_cursor', 'Agent changed while reading history')
        renderInput = mergeHistory(page.entries, runtime, provider)
        older = page.olderCursor; sourceIdentity = page.sourceIdentity
      } catch (error) {
        if (error instanceof ControlError && error.code === 'stale_cursor') throw error
        metadata.availability = runtime.entries.length || runtime.semantic.currentTurn || runtime.semantic.history.length ? 'live_only' : 'unavailable'
        metadata.reason = `Durable history unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
    } else if (!meta.providerSessionId) {
      metadata.availability = runtime.entries.length || runtime.semantic.currentTurn || runtime.semantic.history.length ? 'live_only' : 'not_created'
      metadata.reason = 'No native transcript identity is known yet; the agent was not woken.'
    }
    const basis = project(renderInput, provider, input.sessionId, input.depth)
    let rows = basis
    let deleted: string[] = []
    if (input.since) {
      const previous = snapshots.get(input.since, identity, input.depth)
      if (!previous.completed) throw new ControlError('invalid_cursor', 'Finish all message continuations before using a delta cursor')
      ;({ rows, deleted } = changedMessages(previous.basis, basis))
      older = null
    } else if (input.range === 'current_exchange') {
      let index = rows.length - 1
      while (index >= 0 && (rows[index].role !== 'user' || rows[index].partial)) index--
      if (index >= 0) rows = rows.slice(index)
      else metadata.reason = `${metadata.reason ? `${metadata.reason} ` : ''}The accepted prompt is outside this history window; follow olderCursor to locate it.`
    } else if (input.range === 'latest') rows = rows.slice(-input.maxMessages)
    if (input.afterMessageId) {
      const index = rows.findIndex(row => row.id === input.afterMessageId)
      if (index < 0) throw new ControlError('stale_cursor', 'afterMessageId is outside this read window; use history pagination or a fresh read')
      rows = rows.slice(index + 1)
    }
    const snapshot = snapshots.create({ identity, metadata, rows, basis, deleted, older: null })
    if (older) snapshot.older = saveArchive({ identity, depth: input.depth, cursor: older, sourceIdentity,
      runtime: renderInput, seen: new Set(basis.map(row => row.id)), baseline: snapshot, transientIds: basis.filter(row => row.source !== 'committed').map(row => row.id) })
    return snapshots.page(snapshot, input)
  }
  return {
    capabilities: [defineCapability({ id: 'agents.read', title: 'Read agent conversation', execution: 'window', effect: 'read',
      target: { kind: 'session', field: 'sessionId' }, input: agentReadInput, output: agentReadOutput,
      description: 'Read an exact agent without waking it. Default conversation depth contains real user prompts and all visible assistant prose (including intermediate messages). status is cheap; activity summarizes tool details; full includes full selected payloads. Range is independent: session, current_exchange, latest, or delta with since. Finish nextCursor pages before olderCursor or deltaCursor. Upsert messages by ID and offset; apply deletedMessageIds for transient ownership changes. Cursors expire after five minutes; changed agent/compaction boundaries require a fresh read. Native-terminal live output may require computer use.',
      handler: read,
    })],
    dispose() { snapshots.dispose(); archives.clear(); boundaries.clear(); if (pruneTimer) clearTimeout(pruneTimer) },
  }
}
