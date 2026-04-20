// WorkIndicator — the single in-feed "agent is working" affordance.
//
// WHY this is the only in-feed working indicator:
//
// Before this component, the feed had three overlapping surfaces
// competing for "the agent is doing something" attention:
//   - `ActivityIndicator` (Feed.tsx local + src/shared/ui/ duplicate)
//     — a pulse-dot + verb row gated on `semanticTurn == null` and
//     suppressed the moment any semantic turn mounted, creating a
//     blind spot in the middle of tool execution.
//   - `SemanticTaskSummary` — a todos/active-tools chrome pill.
//   - `SemanticTurnFooter` — a stop-reason/usage tail.
// None answered "what is Claude/Codex doing right now" clearly. This
// component replaces that chrome with one row driven by a single
// field: `runtime.streamPhase`.
//
// Derivation of `streamPhase` happens in the headless packages — see
// ClaudeProxyAdapter.applyAnthropicEvent / CodexResponsesAdapter.handleFrame
// and docs/superpowers/plans/2026-04-18-thinking-phase-in-headless.md.
// This component is a dumb renderer.
//
// Layout contract: one fixed-height MarkerRow. Phase transitions
// change the label and color; they never change the row height. That
// avoids the mount/unmount scroll jitter the old ActivityIndicator had.

import { memo, useEffect, useState } from 'react'

import { MarkerRow } from './Feed'
import type { StreamPhase } from '../tiles/workspaceState'

type Props = {
  phase: StreamPhase
  turnStartedAt: number | null
  toolName: string | null
  toolHint: string | null
  /** Optional override, primarily for tests/Storybook. When omitted
   *  the component queries `prefers-reduced-motion` directly and
   *  subscribes to changes, so toggling the OS-level setting while
   *  the app is open takes effect immediately. */
  reducedMotion?: boolean
}

export const WorkIndicator = memo(function WorkIndicator({
  phase,
  turnStartedAt,
  toolName,
  toolHint,
  reducedMotion: reducedMotionOverride,
}: Props) {
  const detected = usePrefersReducedMotion()
  const reducedMotion = reducedMotionOverride ?? detected
  // Tick once a second to refresh the elapsed-time suffix. Cheap
  // enough at 1Hz that we don't bother with requestAnimationFrame or
  // a shared clock; the re-render is also scoped to this memoed
  // component via React.memo on the parent wrapper.
  const elapsedSeconds = useElapsedSeconds(turnStartedAt)

  if (phase === 'idle') return null

  const label = phaseLabel(phase, toolName)
  if (label === null) return null

  const isAwaiting = phase === 'awaiting-tool'
  // Awaiting-tool uses `text-ink-dim` (quieter than accent but still
  // legible) to distinguish "tool is running, waiting for result"
  // from the active "thinking / writing / calling" phases. We
  // deliberately avoid introducing an amber/warning theme token for
  // this single use — awaiting a tool isn't an error, and reaching
  // for danger/warning colors here would conflict with how every
  // other surface in the app uses them.
  const toneClass = isAwaiting ? 'text-ink-dim' : 'text-accent'
  const dotClass = isAwaiting ? 'bg-muted' : 'bg-accent'
  const animate = !reducedMotion

  return (
    <MarkerRow marker="" tone={isAwaiting ? 'muted' : 'accent'}>
      <div className="flex items-center gap-2 py-0.5 text-[13px] leading-[1.55]">
        <span
          className={`
            ${dotClass} inline-block w-1.5 h-1.5 rounded-full flex-shrink-0
            ${animate ? 'work-indicator-dot' : ''}
          `}
          aria-hidden="true"
        />
        <span className={`${toneClass} font-medium`}>{label}</span>
        {elapsedSeconds !== null && (
          <span className="text-muted tabular-nums">
            · {formatElapsed(elapsedSeconds)}
          </span>
        )}
        {toolHint !== null && (phase === 'tool-input' || phase === 'tool-use' || phase === 'awaiting-tool') && (
          <span className="text-muted truncate min-w-0">· {toolHint}</span>
        )}
      </div>
    </MarkerRow>
  )
})

// ---------------------------------------------------------------------------
// Phase → label mapping.
// ---------------------------------------------------------------------------
//
// Labels are a closed vocabulary; the TUI spinner verb strings
// (`Cogitating`, `Newspapering`, `working… 12s`) no longer reach the
// chat. `DebugPanel` still surfaces the raw activityStatus for power
// users who want to see Claude's flavor text.

function phaseLabel(phase: StreamPhase, toolName: string | null): string | null {
  switch (phase) {
    case 'idle':
      return null
    case 'submitting':
      return 'Sending'
    case 'requesting':
      return 'Connecting'
    case 'thinking':
      return 'Thinking'
    case 'responding':
      return 'Writing'
    case 'tool-input':
      return toolName ? `Calling ${toolName}` : 'Calling tool'
    case 'tool-use':
      return toolName ? `Running ${toolName}` : 'Running tool'
    case 'awaiting-tool':
      return toolName ? `Awaiting ${toolName}` : 'Awaiting tool'
  }
}

// ---------------------------------------------------------------------------
// Elapsed-time hook.
// ---------------------------------------------------------------------------
//
// Only mounts a timer when `since` is non-null. Returns null otherwise
// — caller renders the elapsed slot as empty. We use 1 Hz intentionally:
// sub-second updates are overkill for a "how long have I been waiting"
// readout, and the re-render cost in the feed (which contains
// potentially hundreds of already-mounted rows) is real.

function useElapsedSeconds(since: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() =>
    since === null ? null : Math.max(0, Math.floor((Date.now() - since) / 1000)),
  )
  useEffect(() => {
    if (since === null) {
      setElapsed(null)
      return
    }
    // Fire once immediately so the switch from null → number isn't
    // a full second behind; then tick at 1 Hz.
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since])
  return elapsed
}

// ---------------------------------------------------------------------------
// Elapsed formatter.
// ---------------------------------------------------------------------------
//
// Under 1 min: `3s`. Under 1 hr: `2m14s`. Else: `1h04m`. Matches the
// format Codex already shows in its TUI Working row and generalises
// cleanly to long-running tools. Uses zero-padded minutes/seconds
// where a positional pad helps scanability.

// ---------------------------------------------------------------------------
// prefers-reduced-motion subscription.
// ---------------------------------------------------------------------------
//
// One-shot `matchMedia` isn't enough: users can toggle the OS-level
// setting while the app is open and we want the pulse to stop
// immediately when they do. The matchMedia change listener covers that.

function usePrefersReducedMotion(): boolean {
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (e: MediaQueryListEvent) => setValue(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return value
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}m${String(s).padStart(2, '0')}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h${String(m).padStart(2, '0')}m`
}
