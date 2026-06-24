import type { SessionMeta } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

export function hasDurableProviderSession(
  meta: Pick<SessionMeta, 'providerSessionId' | 'providerSessionIdSource'> | null | undefined,
): meta is Pick<SessionMeta, 'providerSessionId' | 'providerSessionIdSource'> & { providerSessionId: string } {
  if (!meta?.providerSessionId) return false
  // WHY missing source is treated as durable:
  //
  // Workspaces saved before providerSessionIdSource existed only persisted ids
  // that came from JSONL capture or explicit resume. Treating those legacy ids
  // as provisional would silently break reload for existing users.
  return meta.providerSessionIdSource !== 'proxy-header'
}

export function seedResumedRuntimeFields(
  existing: SessionRuntime | undefined,
  meta: Pick<SessionMeta, 'providerSessionId' | 'providerSessionIdSource'> | null | undefined,
): Pick<
  SessionRuntime,
  | 'hasOlderHistory'
  | 'transcriptStatus'
  | 'transcriptError'
  | 'processStatus'
  | 'processError'
  | 'inputReady'
> {
  const stickyTranscript =
    existing?.transcriptStatus === 'ready' ||
    existing?.transcriptStatus === 'error' ||
    existing?.transcriptStatus === 'disconnected'
  const preserveProcess = existing !== undefined && existing.processStatus !== 'idle'
  // WHY this is a single helper instead of inline spawn/rehydrate ternaries:
  // provider start is not a quiet boundary. Codex resume can synchronously replay
  // JSONL and even report exit before `spawnSession()` resolves, so an existing
  // non-idle runtime is more authoritative than the bookkeeping code that runs
  // after the await. Four copies of this priority rule had to stay identical; a
  // helper makes the race contract explicit and keeps future lifecycle fields
  // from being reset in only one restore path.
  return {
    hasOlderHistory: Boolean(existing?.hasOlderHistory) || hasDurableProviderSession(meta),
    transcriptStatus: stickyTranscript
      ? existing.transcriptStatus
      : meta?.providerSessionId ? 'loading' : 'ready',
    transcriptError: existing?.transcriptError ?? null,
    processStatus: preserveProcess ? existing.processStatus : 'started',
    processError: existing?.processError ?? null,
    inputReady: preserveProcess ? existing.inputReady : true,
  }
}

export function resumableProviderSessionId(
  meta: Pick<SessionMeta, 'providerSessionId' | 'providerSessionIdSource'> | null | undefined,
): string | undefined {
  return hasDurableProviderSession(meta) ? meta?.providerSessionId : undefined
}

export function withoutProvisionalProviderSession(meta: SessionMeta): SessionMeta {
  if (meta.providerSessionIdSource !== 'proxy-header') return meta
  const { providerSessionId: _providerSessionId, providerSessionIdSource: _source, ...rest } = meta
  return rest
}

export function shouldMarkProviderSessionDisconnected(
  runtime: Pick<SessionRuntime, 'lastJsonlEntryAt' | 'totalEntries' | 'transcriptStatus'>,
  meta: Pick<SessionMeta, 'providerSessionId' | 'providerSessionIdSource'> | null | undefined,
): boolean {
  if (!meta) return false
  if (hasDurableProviderSession(meta)) return false
  if (runtime.transcriptStatus === 'loading' || runtime.transcriptStatus === 'ready') return false
  return runtime.lastJsonlEntryAt === null && runtime.totalEntries === 0
}

export function isSessionExited(
  runtime: { exited?: SessionRuntime['exited']; processStatus?: SessionRuntime['processStatus'] | string },
): boolean {
  return (
    (runtime.exited !== null && runtime.exited !== undefined) ||
    runtime.processStatus === 'exited'
  )
}

export type JsonlProviderSessionResolution =
  | {
      status: 'unchanged'
      meta: SessionMeta
    }
  | {
      status: 'updated'
      meta: SessionMeta
    }
  | {
      status: 'conflict'
      meta: SessionMeta
      current: string
      incoming: string
      currentSource: SessionMeta['providerSessionIdSource'] | null
    }

export function applyJsonlProviderSessionId(
  meta: SessionMeta,
  providerSessionId: string,
): JsonlProviderSessionResolution {
  const source = 'jsonl-entry' as const
  if (meta.providerSessionId === providerSessionId && meta.providerSessionIdSource === source) {
    return { status: 'unchanged', meta }
  }
  if (
    meta.providerSessionId &&
    meta.providerSessionId !== providerSessionId &&
    meta.providerSessionIdSource !== 'proxy-header'
  ) {
    return {
      status: 'conflict',
      meta,
      current: meta.providerSessionId,
      incoming: providerSessionId,
      currentSource: meta.providerSessionIdSource ?? null,
    }
  }
  // WHY JSONL is allowed to replace proxy-header:
  //
  // The proxy header is the earliest identity signal, but it is deliberately
  // provisional. A committed JSONL entry is the first proof that history is
  // durable and reloadable, so it upgrades the source even if the id matches
  // and replaces the id if the early header belonged to a transient fork.
  return {
    status: 'updated',
    meta: {
      ...meta,
      providerSessionId,
      providerSessionIdSource: source,
    },
  }
}
