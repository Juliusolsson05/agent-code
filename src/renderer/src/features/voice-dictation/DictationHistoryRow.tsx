import { useCallback, useEffect, useState } from 'react'

import type { DictationHistoryEntry, DictationHistorySnapshot } from '@preload/api/types'

// Dictation history + stats panel for the Settings page.
//
// WHY this row self-subscribes instead of going through the Zustand Settings
// pipeline: the data lives in a main-owned JSON store
// (src/main/dictation/historyStore.ts), not in `Settings`. Same marker-row
// pattern as DictationApiKeyRow and CliUpdateBehaviorRow. Beyond the type
// mismatch there is a concrete cost argument — hoisting it into the registry
// would pull the entire transcript list over IPC on every Settings render.
//
// WHY the mutating calls do not refetch: every history IPC resolves with the
// FRESH snapshot, so a mutation is one round-trip and there is no window where
// the list and the totals disagree.

/** Above this, the WPM meter is pinned full. 180 wpm is roughly the top of
 *  conversational speech; the bar is a sense-of-scale cue, not a gauge. */
const WPM_METER_CEILING = 180

const PREVIEW_CHARS = 100

export function DictationHistoryRow() {
  const [snapshot, setSnapshot] = useState<DictationHistorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<'clear' | 'reset' | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .listDictationHistory()
      .then(next => {
        if (!cancelled) setSnapshot(next)
      })
      .catch(() => {
        if (!cancelled) setError('Could not read dictation history.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const mutate = useCallback(
    async (operation: () => Promise<DictationHistorySnapshot>) => {
      setBusy(true)
      setError(null)
      try {
        setSnapshot(await operation())
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update dictation history.')
      } finally {
        setBusy(false)
        setConfirming(null)
      }
    },
    [],
  )

  if (error && !snapshot) {
    return (
      <div role="alert" className="text-[11px] text-danger">
        {error}
      </div>
    )
  }

  if (!snapshot) {
    return <div className="text-[11px] text-muted italic">Loading dictation history…</div>
  }

  const { stats, entries } = snapshot
  const wpm = Math.round(stats.averageWpm)

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Words" value={formatNumber(stats.lifetimeWords)} />
        <StatTile label="Sessions" value={formatNumber(stats.lifetimeSessions)} />
        <div className="border border-control-border bg-control-bg px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">Words/min</div>
          <div
            className="font-code text-[15px] text-ink"
            // The denominator is hold time, not true speaking time — it
            // includes recorder start-up and any silence before release, so
            // the figure reads slightly low. Say so rather than fudge it.
            title="Averaged over how long the dictation key was held, which includes start-up and trailing silence — so this reads slightly low."
          >
            {wpm > 0 ? wpm : '—'}
          </div>
          <div className="mt-1 h-[3px] w-full bg-control-border">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.min(100, Math.round((wpm / WPM_METER_CEILING) * 100))}%` }}
            />
          </div>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-[11px] text-muted">
          {stats.lifetimeSessions > 0
            ? 'No transcripts retained. Your lifetime statistics above are unaffected.'
            : 'Your recent dictations will appear here.'}
        </div>
      ) : (
        <>
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Recent — last {entries.length}
          </div>
          <ul className="flex flex-col gap-1">
            {entries.map(entry => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                busy={busy}
                onDelete={() =>
                  void mutate(() => window.api.deleteDictationHistoryEntry({ id: entry.id }))
                }
              />
            ))}
          </ul>
        </>
      )}

      <div className="flex items-center gap-2">
        {confirming === null ? (
          <>
            <button
              type="button"
              disabled={busy || entries.length === 0}
              onClick={() => setConfirming('clear')}
              className="border border-control-border bg-control-bg px-2 py-1 text-[11px] text-control-fg hover:border-control-border-hover hover:text-ink disabled:opacity-50"
              title="Remove the retained transcripts. Lifetime statistics are kept."
            >
              Clear List
            </button>
            <button
              type="button"
              disabled={busy || (stats.lifetimeSessions === 0 && entries.length === 0)}
              onClick={() => setConfirming('reset')}
              className="border border-control-border bg-control-bg px-2 py-1 text-[11px] text-danger hover:border-danger disabled:opacity-50"
              title="Remove the transcripts AND zero the lifetime statistics."
            >
              Reset Statistics
            </button>
          </>
        ) : (
          <>
            <span className="text-[11px] text-muted">
              {confirming === 'clear'
                ? 'Remove retained transcripts? Statistics are kept.'
                : 'Remove transcripts and zero all statistics? This cannot be undone.'}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate(
                  confirming === 'clear'
                    ? () => window.api.clearDictationHistory()
                    : () => window.api.resetDictationStats(),
                )
              }
              className="border border-danger bg-control-bg px-2 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(null)}
              className="border border-control-border bg-control-bg px-2 py-1 text-[11px] text-control-fg hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {error ? (
        <div role="alert" className="text-[11px] text-danger">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-control-border bg-control-bg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-code text-[15px] text-ink">{value}</div>
    </div>
  )
}

function HistoryRow({
  entry,
  busy,
  onDelete,
}: {
  entry: DictationHistoryEntry
  busy: boolean
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = useCallback(async () => {
    try {
      // Raw text, deliberately: no <stt> wrapper. The wrapper is a hint for a
      // LIVE dictation ("expect transcription errors"); a transcript the user
      // is deliberately re-using may be going into a note or a commit message,
      // where stray markup is pure noise.
      await navigator.clipboard.writeText(entry.text)
      setCopyState('copied')
    } catch {
      // clipboard.writeText rejects when the document is not focused. Surface
      // it — a copy button that silently does nothing reads as broken.
      setCopyState('failed')
    }
    // A clipboard write has no other visible effect, so the button label IS the
    // confirmation. Revert so the control does not look stuck.
    setTimeout(() => setCopyState('idle'), 1200)
  }, [entry.text])

  return (
    <li className="border border-control-border bg-control-bg">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-control-border/30"
      >
        <span className="font-code text-[10px] text-muted">{formatTime(entry.ts)}</span>
        <span className="font-code text-[10px] text-muted">
          {formatDuration(entry.audioDurationMs)}
        </span>
        <span className="font-code text-[10px] text-muted">{entry.words}w</span>
        <span className="flex-1 truncate text-[11px] text-ink">
          {entry.text.length > PREVIEW_CHARS
            ? `${entry.text.slice(0, PREVIEW_CHARS)}…`
            : entry.text}
        </span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-control-border px-2 py-2">
          <p className="m-0 whitespace-pre-wrap text-[11px] text-ink">{entry.text}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="border border-control-border bg-control-bg px-2 py-1 text-[11px] text-control-fg hover:border-control-border-hover hover:text-ink"
            >
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="border border-control-border bg-control-bg px-2 py-1 text-[11px] text-danger hover:border-danger disabled:opacity-50"
              title="Remove this transcript. Your lifetime statistics are unaffected."
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function formatNumber(value: number): string {
  return value.toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return hhmm
  return `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`
}
