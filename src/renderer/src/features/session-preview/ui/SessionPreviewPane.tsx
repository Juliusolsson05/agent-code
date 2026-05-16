import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  buildPreviewModel,
  countUserTurns,
  type PreviewModel,
} from '@renderer/features/session-preview/previewModel'
import { PreviewTranscript } from '@renderer/features/session-preview/ui/PreviewTranscript'

// SessionPreviewPane — the right-hand "you see the conversation before
// you resume it" pane, à la a Telescope / live-grep preview window.
//
// It owns three things the picker modals shouldn't:
//   1. Fetching — calls window.api.loadInitialHistory (a pure on-disk
//      read; no live session needed) for the highlighted session's
//      transcript TAIL, then runs buildPreviewModel.
//   2. Debouncing — while the user arrows/hovers down a list the
//      highlighted target changes rapidly; we wait out the churn
//      before touching disk.
//   3. Caching — re-hovering a session you already looked at must be
//      instant, with no loading flash. A module-level Map survives
//      across modal opens within an app session.
//
// The picker just tells the pane which session is highlighted; all the
// async lifecycle lives here. Actual rendering is delegated to
// PreviewTranscript, which uses the real feed row components.

// Which session to preview. Exactly the fields loadInitialHistory
// needs — the picker maps its own row shape onto this.
export type PreviewTarget = {
  kind: 'claude' | 'codex'
  // Absolute cwd. For Claude this selects the project transcript dir;
  // for Codex the rollout store is global so an empty string still
  // resolves. Also handed to CodeRenderContext as the workspace root.
  cwd: string
  providerSessionId: string
}

// Tail size. 40 raw JSONL records is enough to recognise a
// conversation (it covers the last several turns) without reading a
// multi-megabyte transcript for a glance.
const PREVIEW_LIMIT = 40

// Long enough to outlast key-repeat while arrowing a list, short
// enough to feel immediate when you settle on a row.
const DEBOUNCE_MS = 120

// Bound the cache. A user browsing a picker rarely highlights more
// than a couple dozen distinct sessions; past that we evict oldest-
// first. Values are PreviewModels (Entry arrays + small index maps).
const CACHE_CAP = 24
const cache = new Map<string, PreviewModel>()

function cacheKey(target: PreviewTarget): string {
  // providerSessionId is globally unique per provider; cwd is not part
  // of identity (the same session always has the same cwd).
  return `${target.kind}:${target.providerSessionId}`
}

function cachePut(key: string, model: PreviewModel): void {
  // Re-insert moves the key to the end (Map preserves insertion order),
  // so the eviction below is true oldest-first.
  cache.delete(key)
  cache.set(key, model)
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

type PaneState =
  | { status: 'idle' } // no session highlighted
  | { status: 'loading' }
  | { status: 'ready'; model: PreviewModel }
  | { status: 'empty' } // session exists but has no renderable content
  | { status: 'error'; message: string }

export function SessionPreviewPane({ target }: { target: PreviewTarget | null }) {
  const [state, setState] = useState<PaneState>({ status: 'idle' })

  // Monotonic request id. Every fetch captures the value at dispatch
  // time; a resolved fetch whose id no longer matches is stale (the
  // user moved on) and drops its result. Without this, fast scrubbing
  // could let an older, slower disk read overwrite a newer one.
  const reqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!target) {
      setState({ status: 'idle' })
      return
    }

    const key = cacheKey(target)
    const cached = cache.get(key)
    if (cached) {
      // Instant path — no loading flash for a session already seen.
      setState(
        cached.entries.length > 0
          ? { status: 'ready', model: cached }
          : { status: 'empty' },
      )
      return
    }

    setState({ status: 'loading' })
    const reqId = ++reqRef.current
    const timer = setTimeout(() => {
      window.api
        .loadInitialHistory({
          kind: target.kind,
          cwd: target.cwd,
          providerSessionId: target.providerSessionId,
          limit: PREVIEW_LIMIT,
        })
        .then(chunk => {
          if (reqId !== reqRef.current) return // superseded
          const model = buildPreviewModel(chunk.entries, target.kind)
          cachePut(key, model)
          setState(
            model.entries.length > 0
              ? { status: 'ready', model }
              : { status: 'empty' },
          )
        })
        .catch((err: unknown) => {
          if (reqId !== reqRef.current) return
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        })
    }, DEBOUNCE_MS)

    // Re-highlight before the debounce fires → cancel the pending read.
    return () => clearTimeout(timer)
  }, [target?.kind, target?.providerSessionId, target?.cwd])

  // Pin the scroll to the bottom whenever fresh content lands. We load
  // the transcript TAIL, so the bottom is the most recent activity —
  // "where you left off", which is what you want to see before
  // resuming. useLayoutEffect so the jump happens before paint.
  useLayoutEffect(() => {
    if (state.status !== 'ready') return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state])

  return (
    <div className="flex flex-col min-h-0 h-full w-full bg-canvas/40">
      <PaneHeader state={state} kind={target?.kind ?? null} />
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        <PaneBody state={state} target={target} />
      </div>
    </div>
  )
}

function PaneHeader({
  state,
  kind,
}: {
  state: PaneState
  kind: 'claude' | 'codex' | null
}) {
  const turns =
    state.status === 'ready' ? countUserTurns(state.model.entries) : null
  return (
    <div className="flex-shrink-0 flex items-center gap-2 border-b border-border px-4 py-2">
      <span className="text-[10px] uppercase tracking-[0.15em] text-muted font-medium">
        preview
      </span>
      {kind && (
        <span className="text-[10px] text-ink-dim lowercase">{kind}</span>
      )}
      {turns !== null && (
        <span className="ml-auto text-[10px] text-muted tabular-nums">
          {turns} {turns === 1 ? 'turn' : 'turns'}
        </span>
      )}
    </div>
  )
}

function PaneBody({
  state,
  target,
}: {
  state: PaneState
  target: PreviewTarget | null
}) {
  if (state.status === 'ready' && target) {
    return (
      <PreviewTranscript
        model={state.model}
        provider={target.kind}
        sessionId={target.providerSessionId}
        workspaceRoot={target.cwd || null}
      />
    )
  }
  // All non-ready states are a single centered line. Kept visually
  // quiet — the pane is a companion to the list, not a focal point.
  const message =
    state.status === 'idle'
      ? 'Highlight a session to preview it'
      : state.status === 'loading'
        ? 'Loading preview…'
        : state.status === 'empty'
          ? 'No conversation recorded'
          : state.status === 'error'
            ? `Couldn't load preview — ${state.message}`
            : ''
  return (
    <div className="h-full flex items-center justify-center px-6 py-12">
      <span
        className={
          'text-[11px] text-center ' +
          (state.status === 'error' ? 'text-danger' : 'text-muted')
        }
      >
        {message}
      </span>
    </div>
  )
}
