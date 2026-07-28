import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'

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

  // `reloadKey` exists so the failure branch can retry. Without it a single
  // transient FS error on mount left `snapshot` null forever: the only thing
  // that cleared `error` was `mutate`, and every control that calls `mutate`
  // lives behind the `!snapshot` early return — so the panel was a dead end
  // until the user closed and reopened Settings, with nothing saying so.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.api
      .listDictationHistory()
      .then(next => {
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Surface the real reason. Main now refuses to read a store it cannot
        // trust (rather than silently reporting it as empty and then
        // overwriting it), so this message is the user's only signal that their
        // history is intact but temporarily unreadable.
        setError(err instanceof Error ? err.message : 'Could not read dictation history.')
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

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
      <div className="flex flex-col gap-2">
        <div role="alert" className="text-[11px] text-danger">
          {error}
        </div>
        <div>
          <Button variant="outline" size="sm" onClick={() => setReloadKey(key => key + 1)}>
            Retry
          </Button>
        </div>
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
            Recent — last {stats.retainedEntries}
          </div>
          {/* Bounded, matching the keybinding list's precedent in
              CommandKeybindingsRow. Unbounded, 200 retained transcripts inject ~5,600px
              into the middle of the Settings page and push every row below
              this one — including Dictation Shortcut, which is what a user
              most likely opened Settings to find — off screen. */}
          <ul className="flex max-h-[320px] flex-col gap-1 overflow-auto">
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

      {/* The `key` on each branch is a SAFETY property, not a lint nicety.
          React reconciles fragment children by index, so without distinct keys
          the <button>Reset Statistics</button> at index 1 and the
          <button>Confirm</button> at index 1 are the same element type and
          React REUSES the same DOM node, swapping only its text. The focused
          element then silently mutates from a safe button into the destructive
          one: a keyboard user holding Enter on "Reset Statistics" gets
          keydown auto-repeat, the first press opens the confirmation, and the
          second press lands on "Confirm" — wiping every lifetime statistic
          inside a single key press, with the "cannot be undone" warning shown
          and dismissed too fast to read. Distinct keys force a remount so the
          reused-node path cannot exist. */}
      <div className="flex items-center gap-2">
        {confirming === null ? (
          <div key="history-actions" className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || entries.length === 0}
              onClick={() => setConfirming('clear')}
              title="Remove the retained transcripts. Lifetime statistics are kept."
            >
              Clear List
            </Button>
            {/* destructive-outline, not destructive: this only OPENS the
                confirmation. The filled treatment is reserved for Confirm. */}
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={busy || (stats.lifetimeSessions === 0 && entries.length === 0)}
              onClick={() => setConfirming('reset')}
              title="Remove the transcripts AND zero the lifetime statistics."
            >
              Reset Statistics
            </Button>
          </div>
        ) : (
          <div
            key="history-confirm"
            className="flex items-center gap-2"
            // Escape is the expected way out of a destructive prompt, and
            // without it a keyboard user who opened this by accident has to
            // hunt for Cancel past up to 200 transcript rows.
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setConfirming(null)
              }
            }}
          >
            {/* role="alert" so a screen reader announces that a destructive
                confirmation is now pending — otherwise the prompt is silent. */}
            <span role="alert" className="text-[11px] text-muted">
              {confirming === 'clear'
                ? 'Remove retained transcripts? Statistics are kept.'
                : 'Remove transcripts and zero all statistics? This cannot be undone.'}
            </span>
            <Button
              // This click IS the destructive act, so it takes the stronger
              // border while staying unfilled — a filled button here would be
              // the brightest thing on the Settings page.
              variant="destructive-outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void mutate(
                  confirming === 'clear'
                    ? () => window.api.clearDictationHistory()
                    : () => window.api.resetDictationStats(),
                )
              }
              className="border-danger"
            >
              Confirm
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              // Focus lands on CANCEL, never Confirm. The remount above
              // destroys the previously focused node, so something must claim
              // focus deliberately; the safe choice is the non-destructive one.
              // Button forwards its ref to the underlying <button>, so this
              // keeps working through the primitive.
              ref={node => node?.focus()}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
          </div>
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

  // Held so a second copy can cancel the first one's pending revert. Without
  // this, two copies 300ms apart leave two timers running and the first fires
  // mid-way through the second's confirmation, blanking the label while the
  // user is still looking at it. Also cleared on unmount — deleting a row while
  // its timer is live would otherwise leak it.
  const revertTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (revertTimer.current !== null) window.clearTimeout(revertTimer.current)
    },
    [],
  )

  const copy = useCallback(async () => {
    try {
      // Raw text, deliberately: no <stt> wrapper. The wrapper is a hint for a
      // LIVE dictation ("expect transcription errors"); a transcript the user
      // is deliberately re-using may be going into a note or a commit message,
      // where stray markup is pure noise.
      await navigator.clipboard.writeText(entry.text)
      setCopyState('copied')
    } catch {
      // clipboard.writeText rejects when the document is not focused, and the
      // property access itself throws if clipboard is unavailable. Surface it —
      // a copy button that silently does nothing reads as broken.
      setCopyState('failed')
    }
    // A clipboard write has no other visible effect, so the button label IS the
    // confirmation. Revert so the control does not look stuck.
    if (revertTimer.current !== null) window.clearTimeout(revertTimer.current)
    revertTimer.current = window.setTimeout(() => {
      revertTimer.current = null
      setCopyState('idle')
    }, 1200)
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
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            </Button>
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={busy}
              onClick={onDelete}
              title="Remove this transcript. Your lifetime statistics are unaffected."
            >
              Delete
            </Button>
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
