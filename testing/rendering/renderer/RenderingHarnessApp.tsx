import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Vendored Feed — see testing/rendering/renderer/components/.
// The harness owns its own copy of every renderer component so
// padding / margin / row tweaks here can't bleed into Agent Code.
// Data plumbing (transcript types, parsers, mappers, settings) is
// still imported from src/ — those are stable and the harness wants
// to reproduce Agent Code behavior, not diverge from it.
import { Feed } from './components/Feed'
import {
  claudeHistoryMarker,
  codexHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
  foldSemanticEvent,
  mapCodexRolloutToFeedEntries,
} from '@renderer/workspace/workspaceStore'
import {
  emptySemanticRuntime,
  type SemanticLiveTurn,
  type SemanticRuntimeState,
} from '@renderer/workspace/workspaceState'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@shared/types/transcript'
import { extractAssistantInProgress } from '@shared/parsers/extractAssistant'
import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'

// Rendering Debug Harness.
//
// One spawned session at a time, every layer of the rendering pipeline
// visible side by side: rendered Feed | raw terminal | raw jsonl |
// semantic events. The harness mirrors workspaceStore's entry-ingest
// logic so any rendering regression reproduces identically.
//
// REND-1 — bootstrap race (subscriptions must mount BEFORE spawn).
//
//   On a resumed session, claude-code-headless / codex-headless fire
//   the bootstrapTail (~200 jsonl events) DURING `session.start()`.
//   That happens INSIDE the IPC handler that resolves spawnSession()
//   in the renderer. If the renderer waits for spawnSession() to
//   resolve before subscribing to session events, those bootstrap
//   entries are sent to a renderer that has no listener and are
//   permanently lost — visually presents as "only the very last
//   message rendered after I picked the session".
//
//   Agent Code sidesteps this in `workspaceStore` by subscribing at
//   module mount, before any spawn happens. The harness mirrors
//   the same pattern: subscribe at the OUTER component
//   (RenderingHarnessApp), not inside DebugSession which only mounts
//   after setSpawned.
//
//   Refs hold the bookkeeping (oldest marker, seen uuids, provider
//   for entry mapping) so the IPC callbacks always read the current
//   session's context without re-binding when state changes.
//
//   See README → REND-1.

type HarnessSessionInfo = {
  sessionId: string
  provider: 'claude' | 'codex'
  summary: string
  lastModified: number
  cwd?: string
  gitBranch?: string
  firstPrompt?: string
  fileSize: number
}

type RawJsonlEntry = { entry: Record<string, unknown>; file: string }

type SemanticLogItem = {
  id: number
  ts: number
  type: string
  event: Record<string, unknown>
}

// FAT debug stream — one unified log of every signal that affects
// rendering, tagged by layer so you can filter to "show me only
// MAP drops" or "show me everything for turn X". Picks the USEFUL
// signals for finding rendering bugs and explicitly skips the
// noisy ones:
//
//   JSONL — raw entry arrived: shape (type, role, content kinds)
//   MAP   — mapper decision: kept (with output kinds) or dropped
//           (with reason — wrong type, dedup, empty content)
//   SEM   — semantic events except per-token text_delta noise
//           (collapsed into "+N delta" rollups)
//   STATE — spawn / exit / process-state / history-load lifecycle
//
// Skipped on purpose:
//   - per-frame screen snapshots (60Hz, useless to log)
//   - per-byte PTY data
//   - per-token text_delta (rolled up)
//   - duplicate state transitions
// One more layer than the obvious 4: RENDER tells you what UI
// component each new feed entry will dispatch to, mirroring the
// Block dispatcher inside Feed.tsx. The whole point of "what we are
// rendering and where" — without RENDER you can see the data flow
// but not the render decision.
type DebugLayer = 'JSONL' | 'MAP' | 'SEM' | 'STATE' | 'RENDER'

type DebugLogItem = {
  id: number
  // ms since spawn — relative timestamps are vastly more readable
  // than wall-clock when comparing layer ordering across a single
  // session.
  tMs: number
  layer: DebugLayer
  kind: string
  summary: string
  data?: unknown
}

type SpawnedSession = {
  sessionId: string
  provider: 'claude' | 'codex'
  cwd: string
  resumedFrom: string
}

type ScreenState = {
  plain: string
  markdown: string
  recent: string
  recentMarkdown: string
}

const EMPTY_SCREEN: ScreenState = { plain: '', markdown: '', recent: '', recentMarkdown: '' }

// Setup constraint (NOT an Agent Code bug). `process` is not defined
// in the renderer when contextIsolation is on. First version of this
// constant was `process?.env?.HOME ?? '/'` and threw a ReferenceError
// at module load → black screen on first launch. Hardcoded `/` is
// fine: every session that reaches here has a recorded cwd, this is
// just a defensive default.
const DEFAULT_CWD_FALLBACK = '/'

applyTheme(DEFAULT_SETTINGS)

export function RenderingHarnessApp() {
  const [spawned, setSpawned] = useState<SpawnedSession | null>(null)

  // Live state for the active session. Lives at this level (not in
  // DebugSession) so subscriptions can attach BEFORE the user picks a
  // session, eliminating the bootstrap race documented above.
  const [screen, setScreen] = useState<ScreenState>(EMPTY_SCREEN)
  const [entries, setEntries] = useState<Entry[]>([])
  const [rawJsonl, setRawJsonl] = useState<RawJsonlEntry[]>([])
  const [semantic, setSemantic] = useState<SemanticLogItem[]>([])
  // REND-3 (part 1 of 2) — folded semantic runtime drives the
  // SemanticStreamingTurn path inside Feed. Without it Feed falls
  // through to <StreamingRow>, which extracts text from the TUI
  // screen — and the screen still contains the previous assistant
  // text after the user submits, so it briefly renders below the
  // user message until new bytes arrive. Folding the events lets
  // Feed render straight from parsed proxy data, no screen scrape.
  // See README → REND-3.
  const [semanticState, setSemanticState] = useState<SemanticRuntimeState>(
    emptySemanticRuntime,
  )
  // REND-3 (part 2 of 2) — streaming baseline. Captured at submit
  // time as the screen extract that represents the PREVIOUS turn's
  // assistant text. Feed's `isStaleStreamingExtract` then suppresses
  // <StreamingRow> while the screen still matches this baseline —
  // safety net for sessions where semanticTurn is null (proxy off,
  // codex). Mirrors workspaceStore.setStreamingBaseline. See README →
  // REND-3.
  const [streamingBaseline, setStreamingBaseline] = useState<string | null>(null)
  const [activityStatus, setActivityStatus] = useState<string | null>(null)
  const [awaitingAssistant, setAwaitingAssistant] = useState(false)
  // True between semantic turn_started and turn_completed/stopped.
  // Used together with awaitingAssistant + activityStatus to compute
  // "isLive" so we only mount the streaming preview when something is
  // actually streaming. Mirror of TileLeaf.isSessionLive in the main
  // app — without this gate, on a pure resume the screen still shows
  // the last assistant message AND the JSONL contains it, so Feed
  // would render the same message twice (StreamingRow + EntryRow).
  const [hasActiveTurn, setHasActiveTurn] = useState(false)
  const [exited, setExited] = useState<{ code: number; signal?: number } | null>(null)
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false)
  const [debugLog, setDebugLog] = useState<DebugLogItem[]>([])

  // Per-session bookkeeping refs. Reset in onPick BEFORE spawning so
  // bootstrap entries land into a clean state.
  const providerRef = useRef<'claude' | 'codex'>('claude')
  const oldestMarkerRef = useRef<string | null>(null)
  const seenUuidsRef = useRef<Set<string>>(new Set())
  const semanticCounter = useRef(0)
  // The active managed sessionId; subscriptions filter on this. Set
  // synchronously inside onPick BEFORE awaiting spawn so no events
  // arrive while it's still null. spawn returns a sessionId that
  // matches — main uses the same id from the start of the spawn flow.
  const activeSessionIdRef = useRef<string | null>(null)
  const resumedFromRef = useRef<string | null>(null)
  const cwdRef = useRef<string>('/')
  // Synchronous source of truth for the wider scrollback screen text.
  // Read at submit time to compute the baseline. Mirrors
  // workspaceStore.latestScreenRef.
  const latestRecentScreenRef = useRef<string>('')
  // Spawn-relative time anchor; all debug log entries report ms since
  // this point. Reset in resetForNewSession.
  const spawnEpochRef = useRef<number>(Date.now())
  const debugCounterRef = useRef(0)
  // text_delta rollup buffer — keep noise out of the debug stream
  // without losing the signal that text was streaming. Keyed by
  // turnId+blockIndex; flushed on the next non-delta event for that
  // block, or every ~250ms.
  const textDeltaRollupRef = useRef<
    Map<string, { chars: number; deltas: number; flushTimer: ReturnType<typeof setTimeout> | null }>
  >(new Map())

  const pushDebug = useCallback((item: Omit<DebugLogItem, 'id' | 'tMs'>) => {
    const next: DebugLogItem = {
      id: ++debugCounterRef.current,
      tMs: Date.now() - spawnEpochRef.current,
      ...item,
    }
    setDebugLog(prev => {
      const out = [...prev, next]
      return out.length > 800 ? out.slice(out.length - 800) : out
    })
  }, [])

  const flushTextDeltaRollup = useCallback(
    (key: string) => {
      const buf = textDeltaRollupRef.current.get(key)
      if (!buf) return
      if (buf.flushTimer) clearTimeout(buf.flushTimer)
      textDeltaRollupRef.current.delete(key)
      pushDebug({
        layer: 'SEM',
        kind: 'text_delta_rollup',
        summary: `text_delta ×${buf.deltas} (${buf.chars} chars) [${key}]`,
      })
    },
    [pushDebug],
  )

  // ---- Subscriptions: attached ONCE, route via refs ----
  //
  // We don't filter by sessionId because the harness only ever has
  // one session live at a time. Any leftover event after kill is
  // ignored on the next reset.

  useEffect(() => {
    const offs: Array<() => void> = []

    offs.push(
      window.api.onSessionScreen(evt => {
        latestRecentScreenRef.current = evt.recent
        setScreen({
          plain: evt.plain,
          markdown: evt.markdown,
          recent: evt.recent,
          recentMarkdown: evt.recentMarkdown,
        })
      }),
    )

    offs.push(
      window.api.onSessionJsonlEntries(evt => {
        // Filter by active session — main can in theory deliver
        // events for a previous session whose kill is still draining.
        if (activeSessionIdRef.current && evt.sessionId !== activeSessionIdRef.current) return

        setRawJsonl(prev => [...prev, ...evt.entries])

        const provider = providerRef.current
        const seen = seenUuidsRef.current
        const appended: Entry[] = []

        for (const { entry: raw } of evt.entries) {
          // ---- JSONL log: shape only ----
          // We log every raw arrival so MAP drops can be correlated
          // back to the input. Summary picks the most identifying
          // fields per provider shape.
          pushDebug({
            layer: 'JSONL',
            kind: typeof raw.type === 'string' ? raw.type : 'unknown',
            summary: jsonlShapeSummary(raw, provider),
            data: raw,
          })

          if (provider === 'codex') {
            const marker = codexHistoryMarker(raw)
            const mapped = mapCodexRolloutToFeedEntries(raw)
            if (mapped.length > 0 && !oldestMarkerRef.current) {
              oldestMarkerRef.current = marker
            }
            if (mapped.length === 0) {
              pushDebug({
                layer: 'MAP',
                kind: 'drop',
                summary: `codex ${describeCodexRaw(raw)} → 0 entries (mapper returned none)`,
                data: raw,
              })
              continue
            }
            let kept = 0
            const dropped: string[] = []
            for (const feedEntry of mapped) {
              const uuid = entryUuid(feedEntry)
              if (typeof uuid === 'string') {
                if (seen.has(uuid)) {
                  dropped.push('dedup')
                  continue
                }
                seen.add(uuid)
              }
              appended.push(feedEntry)
              kept += 1
            }
            pushDebug({
              layer: 'MAP',
              kind: kept > 0 ? 'keep' : 'drop',
              summary: `codex ${describeCodexRaw(raw)} → ${kept} kept${
                dropped.length > 0 ? `, ${dropped.length} dropped (${dropped.join('/')})` : ''
              } [${mapped.map(feedEntrySignature).join(' ')}]`,
              data: { input: raw, mapped },
            })
            continue
          }

          // Claude: progress wrapper unwrap, then filter to known
          // entry shapes the Feed knows how to render.
          const feedEntry =
            extractEmbeddedClaudeProgressEntry(raw) ?? (raw as Entry)
          const marker = claudeHistoryMarker(raw)
          if (marker && !oldestMarkerRef.current) {
            oldestMarkerRef.current = marker
          }
          if (
            !isConversationEntry(feedEntry) &&
            !isCompactBoundaryEntry(feedEntry) &&
            !isCompactSummaryEntry(feedEntry)
          ) {
            pushDebug({
              layer: 'MAP',
              kind: 'drop',
              summary: `claude ${describeClaudeRaw(raw)} → dropped (filter: not conversation/compact)`,
              data: { input: raw, derived: feedEntry },
            })
            continue
          }
          const uuid = entryUuid(feedEntry)
          if (typeof uuid === 'string') {
            if (seen.has(uuid)) {
              pushDebug({
                layer: 'MAP',
                kind: 'drop',
                summary: `claude ${describeClaudeRaw(raw)} → dropped (dedup uuid=${uuid.slice(0, 8)})`,
                data: { input: raw, uuid },
              })
              continue
            }
            seen.add(uuid)
          }
          appended.push(feedEntry)
          pushDebug({
            layer: 'MAP',
            kind: 'keep',
            summary: `claude ${describeClaudeRaw(raw)} → kept [${feedEntrySignature(feedEntry)}]`,
            data: { input: raw, mapped: feedEntry },
          })
        }

        if (appended.length > 0) {
          // ---- RENDER log: one line per appended entry, naming the
          // exact Feed Block-dispatcher path each block will take.
          // Mirrors Feed.tsx Block() so you can see the rendering
          // decision without scrolling through React DevTools. ----
          for (const feedEntry of appended) {
            pushDebug({
              layer: 'RENDER',
              kind: renderKindForEntry(feedEntry),
              summary: describeRenderForEntry(feedEntry, provider),
              data: feedEntry,
            })
          }
          setEntries(prev => [...prev, ...appended])
        }
      }),
    )

    offs.push(
      window.api.onSessionSemanticEvent(evt => {
        if (activeSessionIdRef.current && evt.sessionId !== activeSessionIdRef.current) return
        const ev = asRecord(evt.event) ?? {}
        const type = typeof ev.type === 'string' ? ev.type : 'unknown'
        const item: SemanticLogItem = {
          id: ++semanticCounter.current,
          ts: Date.now(),
          type,
          event: ev,
        }
        setSemantic(prev => {
          const next = [...prev, item]
          return next.length > 400 ? next.slice(next.length - 400) : next
        })
        // Fold the event into the live semantic runtime — this is
        // what makes Feed render the proper SemanticStreamingTurn
        // path instead of falling back to the screen-scraping
        // StreamingRow. The fold logic is the same one workspaceStore
        // uses, so the harness's streaming surface is byte-for-byte
        // identical to the main app's.
        setSemanticState(prev => foldSemanticEvent(prev, ev))

        // ---- SEM debug log ----
        // text_delta is the loud one — proxy emits one per token. Roll
        // up by turnId+blockIndex and flush either when the next non-
        // delta event arrives for that block, or on a 250ms quiet
        // window. This keeps the debug stream readable while still
        // showing that streaming happened.
        const turnId = typeof ev.turnId === 'string' ? ev.turnId : 'no-turn'
        const blockIndex = typeof ev.blockIndex === 'number' ? ev.blockIndex : null
        const key = `${turnId}#${blockIndex ?? '?'}`

        if (type === 'text_delta' || type === 'thinking_delta' || type === 'tool_input_delta') {
          const delta = typeof ev.delta === 'string' ? ev.delta : ''
          let buf = textDeltaRollupRef.current.get(key)
          if (!buf) {
            buf = { chars: 0, deltas: 0, flushTimer: null }
            textDeltaRollupRef.current.set(key, buf)
          }
          buf.chars += delta.length
          buf.deltas += 1
          if (buf.flushTimer) clearTimeout(buf.flushTimer)
          buf.flushTimer = setTimeout(() => flushTextDeltaRollup(key), 250)
          return
        }

        // Any non-delta event for this block flushes the rollup so
        // the debug stream stays causally ordered.
        if (textDeltaRollupRef.current.has(key)) flushTextDeltaRollup(key)

        // Maintain hasActiveTurn for the streaming-card gate. Only
        // turn-level events flip this — block-level events fire
        // inside an existing turn and must not reset the flag.
        if (type === 'turn_started') {
          setHasActiveTurn(true)
        } else if (type === 'turn_completed' || type === 'turn_stopped') {
          setHasActiveTurn(false)
        }

        pushDebug({
          layer: 'SEM',
          kind: type,
          summary: semanticDebugSummary(type, ev),
          data: ev,
        })
      }),
    )

    offs.push(
      window.api.onSessionProcessState(evt => {
        if (activeSessionIdRef.current && evt.sessionId !== activeSessionIdRef.current) return
        setActivityStatus(evt.active ? evt.status ?? null : null)
        setAwaitingAssistant(evt.active)
        pushDebug({
          layer: 'STATE',
          kind: evt.active ? 'process_active' : 'process_idle',
          summary: evt.active
            ? `active${evt.status ? ` — ${evt.status}` : ''}`
            : 'idle',
        })
      }),
    )

    offs.push(
      window.api.onSessionExit(evt => {
        if (activeSessionIdRef.current && evt.sessionId !== activeSessionIdRef.current) return
        setExited({ code: evt.exitCode, signal: evt.signal })
        pushDebug({
          layer: 'STATE',
          kind: 'exit',
          summary: `exit code=${evt.exitCode}${evt.signal ? ` signal=${evt.signal}` : ''}`,
        })
      }),
    )

    offs.push(
      window.api.onSessionStarted(evt => {
        if (activeSessionIdRef.current && evt.sessionId !== activeSessionIdRef.current) return
        pushDebug({
          layer: 'STATE',
          kind: 'started',
          summary: `started sessionId=${evt.sessionId.slice(0, 8)} kind=${evt.kind}${
            evt.projectDir ? ` project=${evt.projectDir.split('/').pop()}` : ''
          }`,
        })
      }),
    )

    return () => offs.forEach(off => off())
  }, [pushDebug, flushTextDeltaRollup])

  const resetForNewSession = useCallback(
    (info: HarnessSessionInfo) => {
      providerRef.current = info.provider
      oldestMarkerRef.current = null
      seenUuidsRef.current = new Set()
      semanticCounter.current = 0
      resumedFromRef.current = info.sessionId
      cwdRef.current = info.cwd ?? DEFAULT_CWD_FALLBACK
      spawnEpochRef.current = Date.now()
      debugCounterRef.current = 0
      // Cancel any pending text-delta rollup timers from a prior
      // session so they don't fire and write into the new log.
      for (const buf of textDeltaRollupRef.current.values()) {
        if (buf.flushTimer) clearTimeout(buf.flushTimer)
      }
      textDeltaRollupRef.current = new Map()
      latestRecentScreenRef.current = ''
      setScreen(EMPTY_SCREEN)
      setEntries([])
      setRawJsonl([])
      setSemantic([])
      setSemanticState(emptySemanticRuntime())
      setStreamingBaseline(null)
      setDebugLog([])
      setActivityStatus(null)
      setAwaitingAssistant(false)
      setHasActiveTurn(false)
      setExited(null)
      // Optimistic — a resumed session almost always has >200 entries
      // of history. The first loadOlder response corrects the flag.
      setHasOlderHistory(true)
      setLoadingOlderHistory(false)
    },
    [],
  )

  const onPick = useCallback(
    async (info: HarnessSessionInfo) => {
      resetForNewSession(info)
      const cwd = info.cwd ?? DEFAULT_CWD_FALLBACK
      pushDebug({
        layer: 'STATE',
        kind: 'spawn_request',
        summary: `spawn ${info.provider} resume=${info.sessionId.slice(0, 8)} cwd=${cwd}`,
      })
      const res = await window.api.spawnSession({
        kind: info.provider,
        cwd,
        rows: 48,
        cols: 160,
        resumeSessionId: info.sessionId,
      })
      activeSessionIdRef.current = res.sessionId
      pushDebug({
        layer: 'STATE',
        kind: 'spawn_resolved',
        summary: `spawn resolved sessionId=${res.sessionId.slice(0, 8)}`,
      })
      setSpawned({
        sessionId: res.sessionId,
        provider: info.provider,
        cwd,
        resumedFrom: info.sessionId,
      })
    },
    [resetForNewSession, pushDebug],
  )

  const onLoadOlderHistory = useCallback(async () => {
    if (!resumedFromRef.current) {
      setHasOlderHistory(false)
      return
    }
    if (!oldestMarkerRef.current) {
      setHasOlderHistory(false)
      return
    }
    setLoadingOlderHistory(prev => {
      if (prev) return prev
      // Fire the load asynchronously after the state flip; the gate
      // above prevents reentry while in flight.
      void (async () => {
        const beforeMarker = oldestMarkerRef.current!
        pushDebug({
          layer: 'STATE',
          kind: 'history_load_start',
          summary: `older-history fetch before=${beforeMarker.slice(0, 12)}`,
        })
        try {
          const chunk = await window.api.loadOlderHistory({
            kind: providerRef.current,
            cwd: cwdRef.current,
            providerSessionId: resumedFromRef.current!,
            beforeMarker: oldestMarkerRef.current!,
            limit: 200,
          })
          const seen = seenUuidsRef.current
          const prepend: Entry[] = []
          let oldestMarker: string | null = oldestMarkerRef.current
          const originalMarker = oldestMarkerRef.current

          for (const raw of chunk.entries) {
            if (providerRef.current === 'codex') {
              const marker = codexHistoryMarker(raw)
              const mapped = mapCodexRolloutToFeedEntries(raw)
              if (mapped.length > 0 && oldestMarker === originalMarker) {
                oldestMarker = marker
              }
              for (const entry of mapped) {
                const uuid = entryUuid(entry)
                if (typeof uuid === 'string') {
                  if (seen.has(uuid)) continue
                  seen.add(uuid)
                }
                prepend.push(entry)
              }
              continue
            }
            const feedEntry =
              extractEmbeddedClaudeProgressEntry(raw) ?? (raw as Entry)
            const marker = claudeHistoryMarker(raw)
            if (
              !isConversationEntry(feedEntry) &&
              !isCompactBoundaryEntry(feedEntry) &&
              !isCompactSummaryEntry(feedEntry)
            ) {
              continue
            }
            if (marker && oldestMarker === originalMarker) {
              oldestMarker = marker
            }
            const uuid = entryUuid(feedEntry)
            if (typeof uuid === 'string') {
              if (seen.has(uuid)) continue
              seen.add(uuid)
            }
            prepend.push(feedEntry)
          }

          if (prepend.length > 0) {
            // Log RENDER decisions for prepended history too, so the
            // debug stream shows what each older entry will become.
            for (const feedEntry of prepend) {
              pushDebug({
                layer: 'RENDER',
                kind: `prepend:${renderKindForEntry(feedEntry)}`,
                summary: describeRenderForEntry(feedEntry, providerRef.current),
                data: feedEntry,
              })
            }
            setEntries(prev => [...prepend, ...prev])
          }
          oldestMarkerRef.current = oldestMarker ?? oldestMarkerRef.current
          setHasOlderHistory(chunk.hasMore && prepend.length > 0)
          pushDebug({
            layer: 'STATE',
            kind: 'history_load_done',
            summary: `older-history +${prepend.length} (raw ${chunk.entries.length}) hasMore=${chunk.hasMore}`,
          })
        } catch (err) {
          console.warn('[harness] load older failed', err)
          pushDebug({
            layer: 'STATE',
            kind: 'history_load_error',
            summary: `older-history failed: ${String((err as Error).message ?? err)}`,
          })
        } finally {
          setLoadingOlderHistory(false)
        }
      })()
      return true
    })
  }, [pushDebug])

  const onClose = useCallback(async () => {
    if (spawned) {
      try {
        await window.api.killSession(spawned.sessionId)
      } catch {
        // best-effort
      }
    }
    activeSessionIdRef.current = null
    setSpawned(null)
  }, [spawned])

  // Setup constraint (NOT an Agent Code bug): every hook in this
  // component must run on every render. First version of this
  // `useCallback` was declared AFTER the `if (!spawned) return …`
  // early return — phase-1 render skipped it, phase-2 called it,
  // React threw error #310. Symptom was a black screen the moment
  // you picked a session. Keep ALL hook calls above the early
  // return.
  const onBeforeSubmit = useCallback(() => {
    const provider = providerRef.current
    const baseline = extractAssistantInProgress(
      latestRecentScreenRef.current,
      provider,
    )
    setStreamingBaseline(baseline)
    setAwaitingAssistant(true)
    pushDebug({
      layer: 'STATE',
      kind: 'baseline_captured',
      summary: `streamingBaseline ← screen extract (${baseline.length} chars)`,
      data: { baseline },
    })
  }, [pushDebug])

  if (!spawned) {
    return <SessionPicker onPick={onPick} />
  }

  // REND-2 — live-gate suppresses the streaming preview when no
  // turn is in flight. Without this, on a pure resume the screen
  // still contained the last assistant message AND the JSONL
  // bootstrap brought the same message in as an Entry → both
  // rendered, "double-rendered last message". Mirror of
  // TileLeaf.isSessionLive in Agent Code. See README → REND-2.
  const isLive =
    activityStatus !== null ||
    awaitingAssistant ||
    hasActiveTurn ||
    semanticState.currentTurn !== null

  return (
    <DebugSession
      session={spawned}
      onClose={onClose}
      screen={screen}
      entries={entries}
      rawJsonl={rawJsonl}
      semantic={semantic}
      semanticTurn={semanticState.currentTurn}
      streamingBaseline={streamingBaseline}
      debugLog={debugLog}
      activityStatus={activityStatus}
      isLive={isLive}
      exited={exited}
      hasOlderHistory={hasOlderHistory}
      loadingOlderHistory={loadingOlderHistory}
      onLoadOlderHistory={onLoadOlderHistory}
      onBeforeSubmit={onBeforeSubmit}
    />
  )
}

// -----------------------------------------------------------------------------
// Phase 1 — session picker
// -----------------------------------------------------------------------------

function SessionPicker({ onPick }: { onPick: (info: HarnessSessionInfo) => void }) {
  const [sessions, setSessions] = useState<HarnessSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const list = (await window.api.listAllSessions(500)) as HarnessSessionInfo[]
      if (cancelled) return
      setSessions(list)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(s =>
      [s.summary, s.cwd ?? '', s.gitBranch ?? '', s.firstPrompt ?? '', s.sessionId]
        .some(field => field.toLowerCase().includes(q)),
    )
  }, [sessions, query])

  return (
    <div className="h-screen bg-canvas text-ink font-code overflow-hidden flex flex-col">
      <div className="border-b border-border bg-surface px-5 py-4">
        <div className="text-[13px] text-ink">Agent Code rendering debug</div>
        <div className="mt-1 text-[11px] text-muted">
          Pick a session to resume. Spawns the real agent, shows every pipeline
          layer side by side.
        </div>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="filter by summary / cwd / branch / session id"
          className="mt-3 w-full bg-canvas border border-border text-ink text-[12px] font-code px-3 py-2 outline-none placeholder:text-muted"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
        {loading ? (
          <div className="text-[12px] text-muted py-6 text-center">
            scanning ~/.claude/projects and ~/.codex/sessions …
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-[12px] text-muted py-6 text-center">no sessions match</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map(s => (
              <button
                key={`${s.provider}:${s.sessionId}`}
                type="button"
                disabled={picking !== null}
                onClick={() => {
                  setPicking(s.sessionId)
                  onPick(s)
                }}
                className={`text-left border px-3 py-3 transition-colors ${
                  picking === s.sessionId
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-border-hi bg-canvas'
                } disabled:opacity-50`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] border ${
                      s.provider === 'claude'
                        ? 'border-accent text-accent'
                        : 'border-border text-ink-dim'
                    }`}
                  >
                    {s.provider}
                  </span>
                  <span className="text-[12px] text-ink truncate">{s.summary}</span>
                  <span className="ml-auto text-[10px] text-muted tabular-nums">
                    {formatRelative(s.lastModified)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-muted">
                  {s.cwd ? <span className="truncate">{s.cwd}</span> : null}
                  {s.gitBranch ? <span>⎇ {s.gitBranch}</span> : null}
                  <span className="ml-auto font-mono">{s.sessionId.slice(0, 8)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Phase 2 — spawned debug view (pure presentation, all state is hoisted)
// -----------------------------------------------------------------------------

type DebugSessionProps = {
  session: SpawnedSession
  onClose: () => void
  screen: ScreenState
  entries: Entry[]
  rawJsonl: RawJsonlEntry[]
  semantic: SemanticLogItem[]
  semanticTurn: SemanticLiveTurn | null
  streamingBaseline: string | null
  debugLog: DebugLogItem[]
  activityStatus: string | null
  isLive: boolean
  exited: { code: number; signal?: number } | null
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  onLoadOlderHistory: () => Promise<void>
  onBeforeSubmit: () => void
}

function DebugSession({
  session,
  onClose,
  screen,
  entries,
  rawJsonl,
  semantic,
  semanticTurn,
  streamingBaseline,
  debugLog,
  activityStatus,
  isLive,
  exited,
  hasOlderHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  onBeforeSubmit,
}: DebugSessionProps) {
  const [input, setInput] = useState('')

  // Tool indices the Feed expects. Cheap recompute on entry growth —
  // this is a debug tool, not a hot path.
  const { toolUseIndex, toolResultIndex } = useMemo(() => {
    const useIdx = new Map<string, ToolUseBlock>()
    const resIdx = new Map<string, ToolResultBlock>()
    for (const e of entries) {
      if (!isConversationEntry(e)) continue
      const content = e.message.content
      if (!Array.isArray(content)) continue
      for (const b of content) {
        if (b.type === 'tool_use') {
          const tu = b as ToolUseBlock
          useIdx.set(tu.id, tu)
        } else if (b.type === 'tool_result') {
          const tr = b as ToolResultBlock
          resIdx.set(tr.tool_use_id, tr)
        }
      }
    }
    return { toolUseIndex: useIdx, toolResultIndex: resIdx }
  }, [entries])

  const onSubmit = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    // Capture the streaming baseline BEFORE sending input so it
    // freezes the screen state at the moment of submission. If we
    // captured after, the screen could already be transitioning and
    // the baseline would miss the previous assistant text.
    onBeforeSubmit()
    await window.api.sendInput(session.sessionId, `${text}\r`)
    setInput('')
  }, [input, session.sessionId, onBeforeSubmit])

  return (
    <div className="h-screen w-screen bg-canvas text-ink font-code flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 text-[11px]">
        <span
          className={`px-1.5 py-0.5 uppercase tracking-[0.12em] border ${
            session.provider === 'claude' ? 'border-accent text-accent' : 'border-border text-ink-dim'
          }`}
        >
          {session.provider}
        </span>
        <span className="text-muted">resumed:</span>
        <span className="text-ink tabular-nums">{session.resumedFrom.slice(0, 8)}</span>
        <span className="text-muted">·</span>
        <span className="text-ink-dim truncate">{session.cwd}</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-muted">entries {entries.length}</span>
          <span className="text-muted">jsonl {rawJsonl.length}</span>
          <span className="text-muted">sem {semantic.length}</span>
          <span className="text-muted">debug {debugLog.length}</span>
          {semanticTurn ? (
            <span className="text-accent">turn:{semanticTurn.turnId.slice(0, 6)}</span>
          ) : (
            <span className="text-muted">turn:-</span>
          )}
          {streamingBaseline ? (
            <span className="text-accent">baseline:{streamingBaseline.length}</span>
          ) : (
            <span className="text-muted">baseline:-</span>
          )}
          {loadingOlderHistory ? <span className="text-accent">loading older…</span> : null}
          {exited ? (
            <span className="text-accent">exited ({exited.code})</span>
          ) : isLive ? (
            <span className="text-accent">stream:on</span>
          ) : (
            <span className="text-muted">stream:off</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="border border-border px-2 py-0.5 text-[11px] hover:border-border-hi"
          >
            close
          </button>
        </span>
      </div>

      {/* Setup constraint (NOT an Agent Code bug): split MUST be
       * flex-row, not grid-cols.
       *
       * First implementation used `grid grid-cols-[3fr_2fr]` with no
       * explicit grid-template-rows. Single-row grids inherit
       * row-height = `auto`, so cells size to content. Feed's
       * internal `<div className="h-full overflow-auto">` then
       * resolves `h-full` against an auto-height parent → the
       * scroller gets content-height → nothing to scroll.
       *
       * flex row + flex-1 + min-h-0 propagates the parent's bounded
       * height to both columns. Keep flex. */}
      <div className="flex-1 min-h-0 min-w-0 flex">
        <section className="flex-[3] min-h-0 min-w-0 border-r border-border flex flex-col">
          <PanelHeader label="rendered feed" hint={`provider=${session.provider}`} />
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <Feed
              sessionId={session.sessionId}
              provider={session.provider}
              entries={entries}
              // One owner for live text. semanticTurn is the only
              // source of live assistant text — the vendored Feed no
              // longer accepts `streamingScreen` props. If semantic
              // events aren't flowing (proxy off, non-proxy Codex
              // without screen deltas), the feed stays quiet until
              // the JSONL entry lands. See README → "What we fix".
              semanticTurn={semanticTurn}
              activityStatus={activityStatus}
              tailMode={false}
              workspaceRoot={session.cwd}
              toolUseIndex={toolUseIndex}
              toolResultIndex={toolResultIndex}
              hasOlderHistory={hasOlderHistory}
              loadingOlderHistory={loadingOlderHistory}
              onLoadOlderHistory={onLoadOlderHistory}
            />
          </div>
          <ComposerBar input={input} setInput={setInput} onSubmit={onSubmit} />
        </section>

        <section className="flex-[2] min-h-0 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <TerminalPanel plain={screen.plain} markdown={screen.markdown} />
          </div>
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <JsonlPanel entries={rawJsonl} />
          </div>
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <SemanticPanel items={semantic} />
          </div>
          <div className="flex-[1.4] min-h-0 min-w-0 flex flex-col">
            <DebugStreamPanel items={debugLog} />
          </div>
        </section>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Panels
// -----------------------------------------------------------------------------

function PanelHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="border-b border-border bg-surface px-3 py-1 text-[10px] uppercase tracking-[0.12em] flex items-center gap-3">
      <span className="text-muted">{label}</span>
      {hint ? <span className="text-ink-dim normal-case tracking-normal">{hint}</span> : null}
    </div>
  )
}

function TerminalPanel({ plain, markdown }: { plain: string; markdown: string }) {
  return (
    <div className="h-full min-h-0 min-w-0 border-b border-border flex flex-col">
      <PanelHeader label="raw terminal (screen snapshot)" />
      <div className="flex-1 min-h-0 overflow-auto bg-canvas px-3 py-2">
        <pre className="text-[11px] leading-[1.5] whitespace-pre text-ink-dim">{plain || '…'}</pre>
      </div>
      <details className="border-t border-border">
        <summary className="px-3 py-1 text-[10px] text-muted cursor-pointer select-none">
          screen markdown (bold/italic reconstructed)
        </summary>
        <pre className="bg-canvas px-3 py-2 text-[11px] leading-[1.5] whitespace-pre text-ink-dim max-h-48 overflow-auto">
          {markdown || '…'}
        </pre>
      </details>
    </div>
  )
}

function JsonlPanel({ entries }: { entries: RawJsonlEntry[] }) {
  const tail = useMemo(() => entries.slice(-80).reverse(), [entries])
  return (
    <div className="h-full min-h-0 min-w-0 border-b border-border flex flex-col">
      <PanelHeader label="raw jsonl (tail, newest first)" hint={`total ${entries.length}`} />
      <div className="flex-1 min-h-0 overflow-auto">
        {tail.length === 0 ? (
          <div className="text-[11px] text-muted py-4 text-center">waiting for jsonl…</div>
        ) : (
          tail.map((item, i) => <RawEntryRow key={`${entries.length - i}`} entry={item.entry} />)
        )}
      </div>
    </div>
  )
}

function RawEntryRow({ entry }: { entry: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const kind = typeof entry.type === 'string' ? entry.type : 'unknown'
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-3 py-1 flex items-center gap-2 hover:bg-surface"
      >
        <span className="text-[10px] uppercase tracking-[0.12em] text-accent">{kind}</span>
        <span className="text-[10px] text-muted truncate flex-1">{oneLineSummary(entry)}</span>
        {ts ? <span className="text-[10px] text-muted tabular-nums">{ts.slice(11, 19)}</span> : null}
      </button>
      {open && (
        <pre className="bg-canvas px-3 py-2 text-[10.5px] leading-[1.45] whitespace-pre-wrap break-words text-ink-dim">
          {safeStringify(entry)}
        </pre>
      )}
    </div>
  )
}

function SemanticPanel({ items }: { items: SemanticLogItem[] }) {
  const tail = useMemo(() => items.slice(-80).reverse(), [items])
  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col">
      <PanelHeader label="semantic events" hint={`total ${items.length}`} />
      <div className="flex-1 min-h-0 overflow-auto">
        {tail.length === 0 ? (
          <div className="text-[11px] text-muted py-4 text-center">
            no semantic events yet
          </div>
        ) : (
          tail.map(item => (
            <div
              key={item.id}
              className="px-3 py-1 border-b border-border/60 text-[10.5px] flex items-center gap-2"
            >
              <span className="text-accent uppercase tracking-[0.12em] text-[10px]">{item.type}</span>
              <span className="text-muted truncate flex-1">{semanticSummary(item.event)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// FAT debug stream panel.
//
// Layer filter chips toggle visibility per layer. Default: all on.
// Tail-locked unless the user scrolls up — same trick as a terminal
// log viewer.
function DebugStreamPanel({ items }: { items: DebugLogItem[] }) {
  const [enabled, setEnabled] = useState<Record<DebugLayer, boolean>>({
    JSONL: true,
    MAP: true,
    SEM: true,
    STATE: true,
    RENDER: true,
  })
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [copyToast, setCopyToast] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)

  const filtered = useMemo(
    () => items.filter(item => enabled[item.layer]),
    [items, enabled],
  )

  const copyItems = useCallback(
    async (slice: DebugLogItem[], label: string) => {
      const text = slice.map(formatDebugLine).join('\n')
      try {
        await navigator.clipboard.writeText(text)
        setCopyToast(`copied ${slice.length} (${label})`)
      } catch (err) {
        setCopyToast(`copy failed: ${String((err as Error).message ?? err)}`)
      }
      setTimeout(() => setCopyToast(null), 1600)
    },
    [],
  )

  const copyLastN = useCallback(
    (n: number) => {
      const start = Math.max(0, filtered.length - n)
      void copyItems(filtered.slice(start), `last ${n}`)
    },
    [filtered, copyItems],
  )

  const copyAllVisible = useCallback(() => {
    void copyItems(filtered, 'all visible')
  }, [filtered, copyItems])

  // Pin to bottom when new items arrive AND the user hasn't scrolled
  // up. Same auto-tail behavior as journalctl/tail -f.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [filtered])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyRef.current = distFromBottom < 16
  }, [])

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col">
      <div className="border-b border-border bg-surface px-3 py-1 flex items-center gap-2 text-[10px]">
        <span className="text-muted uppercase tracking-[0.12em]">debug stream</span>
        <span className="text-ink-dim normal-case tabular-nums">
          {filtered.length}/{items.length}
        </span>
        {copyToast ? <span className="text-accent normal-case">{copyToast}</span> : null}

        <span className="ml-auto flex items-center gap-1">
          {/* Copy controls. We snapshot the FILTERED view so the
            * user gets exactly what's on screen — last 50 visible,
            * etc. — instead of having "copy" silently include
            * filtered-out layers. */}
          <button
            type="button"
            onClick={() => copyLastN(50)}
            className="border border-border/80 text-ink-dim hover:text-ink hover:border-border-hi px-1.5 py-0.5 normal-case tracking-normal"
          >
            copy 50
          </button>
          <button
            type="button"
            onClick={() => copyLastN(200)}
            className="border border-border/80 text-ink-dim hover:text-ink hover:border-border-hi px-1.5 py-0.5 normal-case tracking-normal"
          >
            copy 200
          </button>
          <button
            type="button"
            onClick={copyAllVisible}
            className="border border-border/80 text-ink-dim hover:text-ink hover:border-border-hi px-1.5 py-0.5 normal-case tracking-normal"
          >
            copy all
          </button>

          <span className="mx-1 text-muted">|</span>

          {(['STATE', 'JSONL', 'MAP', 'SEM', 'RENDER'] as DebugLayer[]).map(layer => (
            <button
              key={layer}
              type="button"
              onClick={() => setEnabled(prev => ({ ...prev, [layer]: !prev[layer] }))}
              className={`px-1.5 py-0.5 border tracking-[0.12em] uppercase ${
                enabled[layer]
                  ? `${LAYER_BORDER[layer]} ${LAYER_TEXT[layer]}`
                  : 'border-border/60 text-muted'
              }`}
            >
              {layer}
            </button>
          ))}
        </span>
      </div>

      {/* The list. select-text on every row so the user can drag-
       * select log lines and copy them with ⌘C. The chevron column
       * stays click-toggleable for expand/collapse. */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-[11px] text-muted py-4 text-center">no events</div>
        ) : (
          filtered.map(item => {
            const isOpen = expanded[item.id]
            return (
              <div key={item.id} className="border-b border-border/50 select-text">
                <div className="px-3 py-1 flex items-center gap-2 hover:bg-surface/60">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded(prev => ({ ...prev, [item.id]: !prev[item.id] }))
                    }
                    aria-label={isOpen ? 'collapse' : 'expand'}
                    className="text-[10px] text-muted shrink-0 w-3 leading-none hover:text-ink"
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                  <span className="text-[10px] tabular-nums text-muted w-12 shrink-0">
                    {formatRelativeMs(item.tMs)}
                  </span>
                  <span
                    className={`text-[10px] uppercase tracking-[0.12em] w-14 shrink-0 ${LAYER_TEXT[item.layer]}`}
                  >
                    {item.layer}
                  </span>
                  <span className="text-[10px] text-ink-dim w-32 shrink-0 truncate font-mono">
                    {item.kind}
                  </span>
                  <span className="text-[10.5px] text-ink font-mono flex-1 truncate">
                    {item.summary}
                  </span>
                </div>
                {isOpen && item.data !== undefined && (
                  <pre className="bg-canvas px-3 py-2 text-[10px] leading-[1.45] whitespace-pre-wrap break-words text-ink-dim max-h-72 overflow-auto select-text font-mono">
                    {safeStringify(item.data)}
                  </pre>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// One log line as plain text — used by the copy buttons. Tab-aligned
// so it pastes cleanly into a spreadsheet or sticks in a markdown
// code block without losing column alignment.
function formatDebugLine(item: DebugLogItem): string {
  return `${formatRelativeMs(item.tMs).padStart(7)}\t${item.layer.padEnd(6)}\t${item.kind.padEnd(20)}\t${item.summary}`
}

const LAYER_TEXT: Record<DebugLayer, string> = {
  JSONL: 'text-sky-400',
  MAP: 'text-emerald-400',
  SEM: 'text-amber-400',
  STATE: 'text-fuchsia-400',
  RENDER: 'text-rose-400',
}

const LAYER_BORDER: Record<DebugLayer, string> = {
  JSONL: 'border-sky-400/60',
  MAP: 'border-emerald-400/60',
  SEM: 'border-amber-400/60',
  STATE: 'border-fuchsia-400/60',
  RENDER: 'border-rose-400/60',
}

function ComposerBar({
  input,
  setInput,
  onSubmit,
}: {
  input: string
  setInput: (v: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="border-t border-border bg-surface px-3 py-2 flex items-center gap-2">
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void onSubmit()
          }
        }}
        placeholder="send input to live session (Enter to submit)"
        className="flex-1 bg-canvas border border-border text-ink text-[12px] font-code px-3 py-1.5 outline-none placeholder:text-muted"
      />
      <button
        type="button"
        onClick={onSubmit}
        className="border border-accent text-accent px-3 py-1.5 text-[12px] hover:bg-accent/10"
      >
        send
      </button>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function entryUuid(entry: Entry): string | undefined {
  return typeof entry.uuid === 'string' ? entry.uuid : undefined
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function oneLineSummary(entry: Record<string, unknown>): string {
  const msg = asRecord(entry.message)
  if (msg) {
    const content = msg.content
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').slice(0, 140)
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = asRecord(block)
        const text = stringField(b, 'text')
        if (text) return text.replace(/\s+/g, ' ').slice(0, 140)
        if (b.type === 'tool_use' && typeof b.name === 'string') return `tool_use: ${b.name}`
        if (b.type === 'tool_result') return 'tool_result'
      }
    }
  }
  const payload = asRecord(entry.payload)
  if (payload) {
    if (typeof payload.type === 'string') return `payload.${payload.type}`
  }
  return ''
}

function semanticSummary(ev: Record<string, unknown>): string {
  const keys = ['turnId', 'blockIndex', 'toolName', 'text', 'source', 'stopReason']
  for (const key of keys) {
    const v = ev[key]
    if (typeof v === 'string') return `${key}=${v.slice(0, 80)}`
    if (typeof v === 'number') return `${key}=${v}`
  }
  return safeStringify(ev).slice(0, 140)
}

function formatRelative(ts: number): string {
  const diffSec = Math.max(0, (Date.now() - ts) / 1000)
  if (diffSec < 60) return `${Math.floor(diffSec)}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  return `${Math.floor(diffSec / 86400)}d`
}

// ---------- Debug-stream summarizers ----------
//
// These produce the one-liner rendered in the debug stream. Each one
// picks the FEW fields that identify the event and skip everything
// else. Full payloads are still in `data` for the click-to-expand.

function formatRelativeMs(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`
  return `+${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

function jsonlShapeSummary(
  raw: Record<string, unknown>,
  provider: 'claude' | 'codex',
): string {
  if (provider === 'codex') return describeCodexRaw(raw)
  return describeClaudeRaw(raw)
}

function describeClaudeRaw(raw: Record<string, unknown>): string {
  const t = String(raw.type ?? 'unknown')
  if (t === 'progress') {
    const data = asRecord(raw.data)
    const embedded = asRecord(data?.message)
    if (embedded) {
      const role = String(embedded.type ?? '')
      return `progress[${role}]`
    }
    return 'progress'
  }
  const message = asRecord(raw.message)
  if (message) {
    const role = String(message.role ?? '')
    const content = message.content
    let blockSummary = ''
    if (typeof content === 'string') {
      blockSummary = `text(${content.length})`
    } else if (Array.isArray(content)) {
      const kinds = content.map(b => {
        const block = asRecord(b)
        if (block?.type === 'text') {
          const txt = stringField(block, 'text') ?? ''
          return `text(${txt.length})`
        }
        if (block?.type === 'tool_use') return `tool_use:${String(block.name ?? '?')}`
        if (block?.type === 'tool_result') return 'tool_result'
        if (block?.type === 'thinking') return 'thinking'
        return String(block?.type ?? '?')
      })
      blockSummary = kinds.join('+')
    }
    const isMeta = raw.isMeta === true ? ' meta' : ''
    const isSidechain = raw.isSidechain === true ? ' sidechain' : ''
    return `${t}[${role}] ${blockSummary}${isMeta}${isSidechain}`
  }
  if (t === 'summary') {
    const sum = typeof raw.summary === 'string' ? raw.summary : ''
    return `summary(${sum.length})`
  }
  return t
}

function describeCodexRaw(raw: Record<string, unknown>): string {
  const envelopeType = String(raw.type ?? 'unknown')
  const payload = asRecord(raw.payload)
  if (!payload) return envelopeType
  const payloadType = String(payload.type ?? '?')
  if (envelopeType === 'response_item') {
    if (payloadType === 'message') {
      const role = String(payload.role ?? '?')
      const content = Array.isArray(payload.content) ? payload.content : []
      const kinds = content.map(b => {
        const block = asRecord(b)
        if (block?.type === 'input_text' || block?.type === 'output_text') {
          const txt = stringField(block, 'text') ?? ''
          return `text(${txt.length})`
        }
        return String(block?.type ?? '?')
      })
      return `response_item.message[${role}] ${kinds.join('+')}`
    }
    if (payloadType === 'function_call') {
      return `response_item.function_call:${String(payload.name ?? '?')}`
    }
    if (payloadType === 'function_call_output') {
      const out = typeof payload.output === 'string' ? payload.output : ''
      return `response_item.function_call_output(${out.length})`
    }
    return `response_item.${payloadType}`
  }
  if (envelopeType === 'event_msg') {
    return `event_msg.${payloadType}`
  }
  return `${envelopeType}.${payloadType}`
}

function feedEntrySignature(entry: Entry): string {
  if (isCompactBoundaryEntry(entry)) return 'compact_boundary'
  if (isCompactSummaryEntry(entry)) return 'compact_summary'
  if (!isConversationEntry(entry)) return String((entry as { type?: string }).type ?? '?')
  const role = entry.message.role
  const content = entry.message.content
  let blocks = ''
  if (typeof content === 'string') {
    blocks = `text(${content.length})`
  } else if (Array.isArray(content)) {
    blocks = content
      .map(b => {
        const block = asRecord(b)
        if (block?.type === 'text') return `text(${(stringField(block, 'text') ?? '').length})`
        if (block?.type === 'tool_use') return `tool_use:${String(block.name ?? '?')}`
        if (block?.type === 'tool_result') return 'tool_result'
        if (block?.type === 'thinking') return 'thinking'
        return String(block?.type ?? '?')
      })
      .join('+')
  }
  return `${role}:${blocks}`
}

// Mirror of Feed.tsx Block() dispatcher. We compute the renderer name
// per block without actually mounting anything — the harness wants to
// know which UI component WOULD render each block so a regression
// like "this Edit row stopped showing" is visible in the log even if
// the visual surface is broken.
//
// We deliberately don't reach into Feed's customRendering toggle here
// because the harness boots with customRendering=false (DEFAULT_SETTINGS).
// If we ever expose a toggle in the harness UI, thread it through.
function describeRenderForEntry(entry: Entry, provider: 'claude' | 'codex'): string {
  if (isCompactBoundaryEntry(entry)) return 'CompactBoundaryRow'
  if (isCompactSummaryEntry(entry)) return 'CompactSummaryRow'
  if (!isConversationEntry(entry)) {
    return `Unknown(type=${(entry as { type?: string }).type ?? '?'})`
  }
  const role = entry.message.role
  const content = entry.message.content
  if (typeof content === 'string') {
    return `${role}: TextProse(${content.length})`
  }
  if (!Array.isArray(content) || content.length === 0) {
    return `${role}: empty`
  }
  const renderers: string[] = []
  for (const b of content) {
    const block = asRecord(b)
    const t = block?.type
    if (t === 'text') {
      const txt = stringField(block, 'text') ?? ''
      renderers.push(`TextProse(${txt.length})`)
    } else if (t === 'thinking') {
      renderers.push('ThinkingDetails')
    } else if (t === 'tool_use') {
      const name = String(block.name ?? '?')
      if (provider === 'codex') {
        renderers.push(`CodexToolRow(${name})`)
        continue
      }
      switch (name) {
        case 'Edit':
          renderers.push('EditRow')
          break
        case 'MultiEdit':
          renderers.push('MultiEditRow')
          break
        case 'Write':
          renderers.push('WriteRow')
          break
        case 'TodoWrite':
          renderers.push('TodoRow')
          break
        default:
          renderers.push(`ToolUseRow(${name})`)
      }
    } else if (t === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id.slice(0, 8) : '?'
      renderers.push(provider === 'codex' ? `CodexToolResultRow(${id})` : `ToolResultRow(${id})`)
    } else {
      renderers.push(`UnknownBlock(${String(t ?? '?')})`)
    }
  }
  const uuid = entryUuid(entry)?.slice(0, 8) ?? '?'
  return `${role} uuid=${uuid} → ${renderers.join(' + ')}`
}

function renderKindForEntry(entry: Entry): string {
  if (isCompactBoundaryEntry(entry)) return 'compact_boundary'
  if (isCompactSummaryEntry(entry)) return 'compact_summary'
  if (!isConversationEntry(entry)) return 'unknown'
  return entry.message.role
}

function semanticDebugSummary(type: string, ev: Record<string, unknown>): string {
  const turn = typeof ev.turnId === 'string' ? ev.turnId.slice(0, 6) : ''
  const block = typeof ev.blockIndex === 'number' ? `b${ev.blockIndex}` : ''
  const tag = [turn, block].filter(Boolean).join('/')
  switch (type) {
    case 'turn_started':
      return `turn_started ${tag}`
    case 'turn_completed':
      return `turn_completed ${tag} stop=${ev.stopReason ?? '?'}`
    case 'turn_stopped':
      return `turn_stopped ${tag} stop=${ev.stopReason ?? '?'}`
    case 'block_started': {
      const kind = ev.kind ?? '?'
      const tool = ev.toolName ? ` tool=${ev.toolName}` : ''
      return `block_started ${tag} kind=${kind}${tool}`
    }
    case 'block_completed':
      return `block_completed ${tag} kind=${ev.kind ?? '?'}`
    case 'tool_input_finalized':
      return `tool_input_finalized ${tag} tool=${ev.toolName ?? '?'}`
    case 'tool_result':
      return `tool_result ${tag} id=${typeof ev.toolUseId === 'string' ? ev.toolUseId.slice(0, 8) : '?'}${
        ev.isError === true ? ' ERROR' : ''
      }`
    case 'usage_updated': {
      const u = asRecord(ev.usage)
      const inTok = u?.['input_tokens'] ?? u?.['inputTokens'] ?? '?'
      const outTok = u?.['output_tokens'] ?? u?.['outputTokens'] ?? '?'
      return `usage ${tag} in=${inTok} out=${outTok}`
    }
    case 'flow_selected':
    case 'flow_ignored':
      return `${type} ${ev.flowId ?? '?'} reason=${ev.reason ?? '?'}`
    case 'source_changed':
      return `source_changed ${tag} → ${ev.source ?? '?'}`
    case 'api_error':
    case 'stream_error':
      return `${type} ${String(ev.message ?? '').slice(0, 80)}`
    default:
      return tag ? `${type} ${tag}` : type
  }
}
