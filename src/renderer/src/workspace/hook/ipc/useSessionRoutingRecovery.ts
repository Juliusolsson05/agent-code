import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useEffect, useRef } from 'react'
import type { SessionRoutingGap } from '@shared/types/sessionRouting'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import { SESSION_ROUTING_REFRESH } from '@renderer/session-runtime/routingGap'

function sameTarget(a: SessionMeta | undefined, b: SessionMeta): boolean {
  return Boolean(a && a.kind === b.kind && a.cwd === b.cwd &&
    a.providerSessionId === b.providerSessionId && a.providerRuntime === b.providerRuntime)
}

/** Desktop window repair; remote subscriptions do not share a BrowserWindow lease. */
export function useSessionRoutingRecovery(
  refs: WorkspaceRefs,
  setRuntimes: WorkspaceSetRuntimes,
  sessions: WorkspaceState['sessions'],
): void {
  const repair = useRef<(gap: SessionRoutingGap, retry?: boolean) => void>(() => {})
  useEffect(() => {
    if (typeof window.api?.onSessionRoutingGap !== 'function') return
    let mounted = true
    const attempts = new Map<string, symbol>()
    repair.current = (gap, retry = false) => {
      const meta = refs.stateRef.current.sessions[gap.sessionId]
      const runtime = refs.latestRuntimesRef.current[gap.sessionId]
      // A claim can precede spawn's reply or workspace adoption. Do not create
      // hidden runtimes here. The scoped pull below recovers unacknowledged
      // notices once that pane is actually present in the workspace.
      if (!mounted || !meta || !runtime || runtime.recoveryFailureCode === 'ownership-conflict') return
      if (!retry && runtime.routingGap?.ownershipRevision === gap.ownershipRevision &&
        runtime.routingGap.gapRevision === gap.gapRevision) return
      const ticket = Symbol('observation-refresh')
      attempts.set(gap.sessionId, ticket)
      const runId = runtime.sessionRunId
      const current = () => mounted && attempts.get(gap.sessionId) === ticket &&
        sameTarget(refs.stateRef.current.sessions[gap.sessionId], meta) &&
        refs.latestRuntimesRef.current[gap.sessionId]?.sessionRunId === runId &&
        refs.latestRuntimesRef.current[gap.sessionId]?.recoveryFailureCode !== 'ownership-conflict'
      const scopedSet: WorkspaceSetRuntimes = next => {
        // The loader mutates seen/tool indices inside its updater. Reject the
        // entire updater BEFORE calling it, not just its returned runtime.
        if (current()) setRuntimes(prev => current() ? (typeof next === 'function' ? next(prev) : next) : prev)
      }
      const phase = (value: 'refreshing' | 'refreshed' | 'unavailable') => {
        if (!mounted || attempts.get(gap.sessionId) !== ticket) return
        setRuntimes(prev => {
          const live = prev[gap.sessionId]
          if (!live || (value !== 'refreshing' && (
            live.routingGap?.ownershipRevision !== gap.ownershipRevision || live.routingGap.gapRevision !== gap.gapRevision
          ))) return prev
          return { ...prev, [gap.sessionId]: { ...live, routingGap: { ...gap, phase: value } } }
        })
      }
      phase('refreshing')
      void (async () => {
        try {
          const seed = await window.api.resyncSessionRouting(gap)
          if (!current() || seed.kind !== 'seeded' || (runId !== null && seed.sessionRunId !== runId)) {
            phase('unavailable')
            return
          }
          if (seed.history) {
            const history = seed.history
            // A provider may change native selection without replacing its
            // process. Repair must not merge that new conversation into the
            // pane's old ledger. Its ordinary binding transition must establish
            // the target first; a routing refresh has no rebinding authority.
            if (history.kind !== (meta.kind ?? DEFAULT_PROVIDER) || history.cwd !== meta.cwd ||
              history.providerSessionId !== meta.providerSessionId) {
              phase('unavailable')
              return
            }
            const loaded = await loadInitialHistoryForSession({
              sessionId: gap.sessionId, refs, setRuntimes: scopedSet, preserveStatusUntilLoaded: true,
              meta: { ...meta, ...history, providerSessionIdSource: 'runtime-start' },
              readHistory: async () => {
                const result = await window.api.loadSessionRoutingHistory(gap, history.sourceKey)
                if (!current() || result.kind !== 'loaded') throw new Error('Saved history is unavailable for this view.')
                return result.chunk
              },
            })
            if (!current() || !loaded) { phase('unavailable'); return }
          }
          phase('refreshed')
        } catch {
          phase('unavailable')
        } finally {
          if (attempts.get(gap.sessionId) === ticket) attempts.delete(gap.sessionId)
        }
      })()
    }
    const off = window.api.onSessionRoutingGap(gap => repair.current(gap))
    const retry = (event: Event) => {
      const sessionId: unknown = (event as CustomEvent).detail
      if (typeof sessionId !== 'string' || attempts.has(sessionId)) return
      const gap = refs.latestRuntimesRef.current[sessionId]?.routingGap
      if (gap) repair.current(gap, true)
    }
    window.addEventListener(SESSION_ROUTING_REFRESH, retry)
    return () => {
      mounted = false
      attempts.clear()
      repair.current = () => {}
      off()
      window.removeEventListener(SESSION_ROUTING_REFRESH, retry)
    }
  }, [refs, setRuntimes])

  useEffect(() => {
    if (typeof window.api?.getSessionRoutingGaps !== 'function') return
    let mounted = true
    // The catalogue contains metadata only and main filters it to this exact
    // renderer generation. It closes subscribe-before-pane/publication races
    // without polling or creating a second unbounded pending-content store.
    void window.api.getSessionRoutingGaps().then(gaps => {
      if (mounted) for (const gap of gaps) repair.current(gap)
    }).catch(() => {})
    return () => { mounted = false }
  }, [sessions])
}
