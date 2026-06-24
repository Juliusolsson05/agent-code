// TranscriptSync — dev-debug module for issue #290 follow-up.
//
// The transcript/rendering failures around Claude are not one signal failing;
// they are mismatches between several clocks and identities: Agent Code's
// session id, the provider session id, JSONL durability, proxy observations,
// feed rendering, and workspace placement. This module deliberately shows the
// cross-product in one focused view so future investigations do not require
// mentally joining DebugPanel + FeedDebugPanel + ProxyDebugPanel + workspace.json.

import { useMemo } from 'react'
import type { ReactNode } from 'react'

import type { DevDebugModule, DevDebugModuleProps } from '@renderer/features/debug/devModules/types'
import {
  hasDurableProviderSession,
  resumableProviderSessionId,
} from '@renderer/workspace/providerSessionIdentity'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import type { FeedDebugEntry } from '@renderer/workspace/workspaceState'

export const transcriptSyncModule: DevDebugModule = {
  id: 'transcript-sync',
  title: 'Transcript Sync',
  description: 'Provider identity, JSONL durability, and renderer transcript-state mismatch checks (#290).',
  Component: TranscriptSync,
}

function TranscriptSync({ sessionId, runtime, kind, workspace }: DevDebugModuleProps) {
  const meta = workspace.state.sessions[sessionId]
  const duplicateProviderSessions = useMemo(
    () => duplicateProviderSessionGroups(workspace.state.sessions),
    [workspace.state.sessions],
  )
  const duplicateForFocused = meta?.providerSessionId
    ? duplicateProviderSessions.find(group => group.providerSessionId === meta.providerSessionId) ?? null
    : null
  const diagnostics = useMemo(
    () => buildDiagnostics({
      sessionId,
      meta,
      runtime,
      duplicateForFocused,
    }),
    [duplicateForFocused, meta, runtime, sessionId],
  )
  const latestFeed = runtime.feedDebugLog.slice(-10).reverse()
  const latestSemantic = runtime.semantic.log.slice(-8).reverse()

  if (!meta) {
    return (
      <Panel title="transcript sync">
        <div className="text-[11px] text-red-300">focused session is missing from workspace state</div>
      </Panel>
    )
  }

  const durable = hasDurableProviderSession(meta)
  const resumableId = resumableProviderSessionId(meta)

  return (
    <Panel title="transcript sync">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="agent session" value={sessionId} />
        <Metric label="kind" value={kind} />
        <Metric label="cwd" value={meta.cwd} wide />
        <Metric label="provider id" value={meta.providerSessionId ?? 'missing'} />
        <Metric label="provider source" value={meta.providerSessionIdSource ?? 'legacy/none'} />
        <Metric label="durable" value={durable ? 'yes' : 'no'} tone={durable ? 'good' : 'warn'} />
        <Metric label="would resume" value={resumableId ? 'yes' : 'no'} tone={resumableId ? 'good' : 'warn'} />
        <Metric label="transcript" value={runtime.transcriptStatus} tone={statusTone(runtime.transcriptStatus)} />
        <Metric label="entries" value={String(runtime.totalEntries)} />
        <Metric label="last jsonl" value={formatTime(runtime.lastJsonlEntryAt)} />
        <Metric label="older history" value={runtime.hasOlderHistory ? 'yes' : 'no'} />
        <Metric label="history marker" value={runtime.historyOldestMarker ?? 'none'} />
      </div>

      <section>
        <Header label="mismatch checks" />
        {diagnostics.length === 0 ? (
          <div className="border border-border bg-canvas px-2 py-1 text-[11px] text-green-300">
            no focused-session mismatch detected
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {diagnostics.map(item => (
              <div
                key={item.id}
                className={`border px-2 py-1 text-[11px] ${
                  item.severity === 'bad'
                    ? 'border-red-500/50 bg-red-950/20 text-red-200'
                    : 'border-yellow-500/50 bg-yellow-950/20 text-yellow-200'
                }`}
              >
                <div className="text-[9px] uppercase tracking-[0.12em] opacity-70">{item.severity}</div>
                <div>{item.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <Header label="identity relationships" />
        <div className="grid grid-cols-2 gap-2">
          <Metric label="linked parent" value={meta.linkedParentId ?? 'none'} />
          <Metric label="orch parent" value={meta.orchestrationParentId ?? 'none'} />
          <Metric label="orch root" value={meta.orchestrationRootId ?? 'none'} />
          <Metric label="duplicate provider ids" value={String(duplicateProviderSessions.length)} tone={duplicateProviderSessions.length > 0 ? 'bad' : 'good'} />
        </div>
        {duplicateForFocused && (
          <pre className="mt-2 max-h-[90px] overflow-auto whitespace-pre-wrap break-words border border-red-500/40 bg-red-950/10 px-2 py-1 text-[10px] text-red-200">
            {duplicateForFocused.sessionIds.join('\n')}
          </pre>
        )}
      </section>

      <section>
        <Header label="recent feed-debug" />
        <EventList entries={latestFeed} />
      </section>

      <section>
        <Header label="recent semantic log" />
        {latestSemantic.length === 0 ? (
          <EmptyLine />
        ) : (
          <div className="flex flex-col gap-1">
            {latestSemantic.map(entry => (
              <pre
                key={entry.id}
                className="max-h-[72px] overflow-auto whitespace-pre-wrap break-words border border-border bg-canvas px-2 py-1 text-[10px] text-ink-dim"
              >
                {JSON.stringify(entry, null, 2)}
              </pre>
            ))}
          </div>
        )}
      </section>
    </Panel>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-border bg-[#101010]">
      <div className="border-b border-border px-3 py-2 text-[10px] text-red-300 uppercase tracking-[0.12em]">
        {title}
      </div>
      <div className="p-3 flex flex-col gap-3">{children}</div>
    </div>
  )
}

function Header({ label }: { label: string }) {
  return (
    <div className="mb-1 text-[9px] text-muted uppercase tracking-[0.12em]">
      {label}
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'neutral',
  wide = false,
}: {
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  wide?: boolean
}) {
  const toneClass =
    tone === 'good'
      ? 'text-green-300'
      : tone === 'warn'
        ? 'text-yellow-300'
        : tone === 'bad'
          ? 'text-red-300'
          : 'text-ink-dim'
  return (
    <div className={`border border-border bg-canvas px-2 py-1 min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <div className="text-[9px] text-muted uppercase tracking-[0.12em]">{label}</div>
      <div className={`mt-0.5 truncate text-[10px] ${toneClass}`} title={value}>
        {value}
      </div>
    </div>
  )
}

function EventList({ entries }: { entries: FeedDebugEntry[] }) {
  if (entries.length === 0) return <EmptyLine />
  return (
    <div className="flex flex-col gap-1">
      {entries.map(entry => (
        <div key={entry.id} className="border border-border bg-canvas px-2 py-1">
          <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.12em]">
            <span className="text-muted">{entry.layer} · {entry.kind}</span>
            <span className="text-muted tabular-nums">{formatTime(entry.ts)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-ink-dim">{entry.summary}</div>
          {entry.data !== undefined && (
            <pre className="mt-1 max-h-[68px] overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

function EmptyLine() {
  return (
    <div className="border border-border bg-canvas px-2 py-1 text-[11px] text-muted">
      none
    </div>
  )
}

function buildDiagnostics({
  sessionId,
  meta,
  runtime,
  duplicateForFocused,
}: {
  sessionId: SessionId
  meta: SessionMeta | undefined
  runtime: DevDebugModuleProps['runtime']
  duplicateForFocused: DuplicateProviderSessionGroup | null
}): Array<{ id: string; severity: 'warn' | 'bad'; message: string }> {
  const out: Array<{ id: string; severity: 'warn' | 'bad'; message: string }> = []
  if (!meta) return out
  const durable = hasDurableProviderSession(meta)
  if (meta.providerSessionIdSource === 'proxy-header' && durable) {
    out.push({
      id: 'proxy-durable',
      severity: 'bad',
      message: 'proxy-header identity is being treated as durable; this would make a provisional id resumable',
    })
  }
  if (runtime.transcriptStatus === 'ready' && runtime.totalEntries === 0 && runtime.lastJsonlEntryAt === null) {
    out.push({
      id: 'ready-empty',
      severity: 'bad',
      message: 'transcript is ready with zero JSONL entries and no lastJsonlEntryAt',
    })
  }
  if (runtime.transcriptStatus === 'disconnected' && runtime.totalEntries > 0) {
    out.push({
      id: 'disconnected-with-entries',
      severity: 'warn',
      message: 'transcript is disconnected even though JSONL entries exist',
    })
  }
  if (meta.providerSessionIdSource === 'proxy-header' && runtime.hasOlderHistory) {
    out.push({
      id: 'proxy-history',
      severity: 'bad',
      message: 'proxy-header identity is advertising older durable history',
    })
  }
  if (duplicateForFocused && duplicateForFocused.sessionIds.length > 1) {
    out.push({
      id: 'duplicate-provider',
      severity: 'bad',
      message: `provider id is shared by ${duplicateForFocused.sessionIds.length} sessions, including ${sessionId}`,
    })
  }
  return out
}

type DuplicateProviderSessionGroup = {
  providerSessionId: string
  sessionIds: SessionId[]
}

function duplicateProviderSessionGroups(
  sessions: Record<SessionId, SessionMeta>,
): DuplicateProviderSessionGroup[] {
  const byProvider = new Map<string, SessionId[]>()
  for (const [sessionId, meta] of Object.entries(sessions)) {
    if (!meta.providerSessionId) continue
    const list = byProvider.get(meta.providerSessionId) ?? []
    list.push(sessionId)
    byProvider.set(meta.providerSessionId, list)
  }
  return Array.from(byProvider.entries())
    .filter(([, sessionIds]) => sessionIds.length > 1)
    .map(([providerSessionId, sessionIds]) => ({ providerSessionId, sessionIds }))
}

function formatTime(value: number | null | undefined): string {
  if (!value) return 'none'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleTimeString()
}

function statusTone(status: string): 'neutral' | 'good' | 'warn' | 'bad' {
  if (status === 'ready') return 'good'
  if (status === 'loading' || status === 'disconnected') return 'warn'
  if (status === 'error') return 'bad'
  return 'neutral'
}
