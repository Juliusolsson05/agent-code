import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FeedDebugEntry, FeedDebugLayer, SessionRuntime } from '@renderer/workspace/workspaceState'

type Props = {
  sessionId: string
  runtime: SessionRuntime
  kind: string
  onClose: () => void
}

const LAYERS: FeedDebugLayer[] = ['STATE', 'JSONL', 'SEM', 'RENDER']

export function FeedDebugPanel({ sessionId, runtime, kind, onClose }: Props) {
  const [enabled, setEnabled] = useState<Record<FeedDebugLayer, boolean>>({
    STATE: true,
    JSONL: true,
    SEM: true,
    RENDER: true,
  })
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [copyToast, setCopyToast] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)

  const items = runtime.feedDebugLog
  const filtered = useMemo(
    () => items.filter(item => enabled[item.layer]),
    [enabled, items],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickyRef.current) return
    el.scrollTop = el.scrollHeight
  }, [filtered])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyRef.current = dist < 16
  }, [])

  const copyItems = useCallback(async (slice: FeedDebugEntry[], label: string) => {
    const text = slice.map(formatLogLine).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyToast(`copied ${slice.length} (${label})`)
    } catch (err) {
      setCopyToast(`copy failed: ${String((err as Error).message ?? err)}`)
    }
    window.setTimeout(() => setCopyToast(null), 1600)
  }, [])

  return (
    <div className="
      h-full w-[540px] flex-shrink-0
      border-l border-border bg-[#0c0c0c]
      flex flex-col overflow-hidden
      text-[10px] font-code
    ">
      <div className="
        flex items-center justify-between
        px-3 py-2 border-b border-border
        text-[9px] text-red-400 uppercase tracking-wider
        select-none flex-shrink-0
      ">
        <span>debug logs — {kind} pane</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-ink text-[14px] leading-none"
        >
          ×
        </button>
      </div>

      <div className="border-b border-border bg-surface px-3 py-1.5 flex items-center gap-2 text-[10px]">
        <span className="text-muted uppercase tracking-[0.12em]">session</span>
        <span className="text-ink-dim">{sessionId.slice(0, 12)}</span>
        <span className="text-muted">·</span>
        <span className="text-ink-dim">{filtered.length}/{items.length}</span>
        {copyToast ? <span className="text-accent">{copyToast}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copyItems(filtered.slice(-50), 'last 50')}
            className="border border-border/80 text-ink-dim hover:text-ink hover:border-border-hi px-1.5 py-0.5"
          >
            copy 50
          </button>
          <button
            type="button"
            onClick={() => void copyItems(filtered, 'all visible')}
            className="border border-border/80 text-ink-dim hover:text-ink hover:border-border-hi px-1.5 py-0.5"
          >
            copy all
          </button>
        </div>
      </div>

      <div className="border-b border-border bg-surface px-3 py-1 flex items-center gap-1">
        {LAYERS.map(layer => (
          <button
            key={layer}
            type="button"
            onClick={() => setEnabled(prev => ({ ...prev, [layer]: !prev[layer] }))}
            className={`px-1.5 py-0.5 border tracking-[0.12em] uppercase ${
              enabled[layer]
                ? 'border-accent/70 text-accent'
                : 'border-border/60 text-muted'
            }`}
          >
            {layer}
          </button>
        ))}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-[11px] text-muted py-4 text-center">no debug log entries</div>
        ) : (
          filtered.map(item => {
            const open = expanded[item.id] ?? item.layer === 'RENDER'
            return (
              <div key={item.id} className="border-b border-border/50 select-text">
                <div className="px-3 py-1 flex items-center gap-2 hover:bg-surface/60">
                  <button
                    type="button"
                    onClick={() => setExpanded(prev => ({ ...prev, [item.id]: !open }))}
                    className="text-[10px] text-muted shrink-0 w-3 leading-none hover:text-ink"
                    aria-label={open ? 'collapse' : 'expand'}
                  >
                    {open ? '▾' : '▸'}
                  </button>
                  <span className={`text-[10px] uppercase tracking-[0.12em] ${layerText(item.layer)}`}>
                    {item.layer}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted w-14 shrink-0">
                    {formatRelativeMs(item.tMs)}
                  </span>
                  <span className="text-[10px] text-muted w-24 shrink-0 truncate">{item.kind}</span>
                  <span className="text-[11px] text-ink-dim flex-1 min-w-0">{item.summary}</span>
                </div>
                {open && item.data !== undefined && (
                  <pre className="bg-canvas px-3 py-2 text-[10.5px] leading-[1.45] whitespace-pre-wrap break-words text-ink-dim">
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

function layerText(layer: FeedDebugLayer): string {
  switch (layer) {
    case 'STATE':
      return 'text-blue-400'
    case 'JSONL':
      return 'text-emerald-400'
    case 'SEM':
      return 'text-amber-400'
    case 'RENDER':
      return 'text-fuchsia-400'
  }
}

function formatRelativeMs(tMs: number): string {
  if (tMs < 1000) return `${tMs}ms`
  return `${(tMs / 1000).toFixed(2)}s`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatLogLine(item: FeedDebugEntry): string {
  const head = `[${formatRelativeMs(item.tMs)}] ${item.layer} ${item.kind} ${item.summary}`
  if (item.data === undefined) return head
  return `${head}\n${safeStringify(item.data)}`
}
