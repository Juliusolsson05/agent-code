import type { SessionMeta } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

export function hasDurableProviderSession(
  meta: Pick<SessionMeta, 'providerSessionId' | 'providerSessionIdSource'> | null | undefined,
): boolean {
  if (!meta?.providerSessionId) return false
  // WHY missing source is treated as durable:
  //
  // Workspaces saved before providerSessionIdSource existed only persisted ids
  // that came from JSONL capture or explicit resume. Treating those legacy ids
  // as provisional would silently break reload for existing users.
  return meta.providerSessionIdSource !== 'proxy-header'
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
