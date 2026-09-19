import { useEffect, useState } from 'react'
import { GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop'
import type { GoalLoopControlAction, GoalLoopState } from '@shared/types/goalLoop'
import { dismissGoalLoop, useGoalLoopView } from './viewState'

const PHASE_LABEL: Record<GoalLoopState['phase'], string> = {
  active: 'active', paused: 'paused', ended: 'ended',
}

function describe(loop: GoalLoopState): string {
  const budget = `${loop.continuationsDelivered}/${loop.maxContinuations}`
  if (loop.phase === 'ended') return `ended (${loop.endReason})`
  if (loop.phase === 'paused') return `paused · ${loop.pauseReason} · ${budget}`
  return `iteration ${budget}`
}

/** Mounts inside TldrPane's relative container (TileTree): a slim always-on
 * status strip while a loop exists for this session, plus the latched control
 * overlay. The strip keeps passive awareness — a running loop is visible
 * without opening anything; the overlay is where actions live. Both follow
 * TldrOverlay's input discipline: stop propagation so pane chrome never sees
 * the clicks, and theme tokens so they read in every theme. */
export function GoalLoopPane({ sessionId }: { sessionId: string }) {
  const [loop, setLoop] = useState<GoalLoopState | null>(null)
  const latched = useGoalLoopView(state => state.latched)
  useEffect(() => {
    // Guard: pane tests stub window.api partially, and a loop surface that
    // crashes a pane over a missing IPC method is worse than one that renders
    // nothing. Production always has both; a missing surface means "no loop".
    if (!window.api?.onGoalLoopChanged || !window.api?.readGoalLoops) return
    let current = true
    // Read on every changed ping rather than threading state through the
    // broadcast: panes may mount mid-loop and the ping is payload-free by
    // design (see ipc.ts), so the durable read is the single source of truth.
    const read = () => {
      void window.api.readGoalLoops([sessionId]).then(loops => {
        if (current) setLoop(loops[sessionId] ?? null)
      }).catch(() => {})
    }
    const unsubscribe = window.api.onGoalLoopChanged(read)
    read()
    return () => { current = false; unsubscribe() }
  }, [sessionId])
  if (!loop) return null
  // Raise cap is clamped to the ceiling main enforces: past 175 an unclamped
  // +25 exceeded the IPC schema's maximum, so the request was rejected and the
  // button silently did nothing. At the ceiling there is nothing to raise, so
  // the button is not offered at all.
  const raisedCap = Math.min(loop.maxContinuations + 25, GOAL_LOOP_MAX_CONTINUATIONS_CEILING)
  const canRaise = loop.phase === 'paused' && loop.pauseReason === 'cap' && raisedCap > loop.maxContinuations
  const control = (action: GoalLoopControlAction) => () => {
    // A rejected control call changes nothing in main, and the next changed
    // ping re-reads the truth; the catch only keeps a rejection from becoming
    // an unhandled one in the renderer.
    void window.api.controlGoalLoop({
      sessionId, action,
      value: action === 'raise-cap' ? raisedCap : undefined,
    }).catch(() => {})
  }
  // NO interaction-ownership marker here, deliberately: the strip is passive
  // status chrome that stays mounted for the loop's whole life (and ended
  // loops persist), while hasAppInteractionOwner() is a document-wide
  // existence query that makes the keyboard router treat ANY mounted marker
  // as a modal owning the interaction — killing every app shortcut (#1004).
  // TldrOverlay may stamp the marker because it mounts it only while a
  // full-screen overlay is visible; only this pane's latched overlay below,
  // also a genuine blocking surface, may do the same.
  const strip = <div
    data-goal-loop-strip=""
    className="pointer-events-auto absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-2 bg-canvas/90 px-3 py-1 text-xs text-ink"
    onMouseDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
  >
    <span className="truncate">Goal loop · {PHASE_LABEL[loop.phase]} · {describe(loop)} · {loop.goal}</span>
    <span className="flex shrink-0 gap-2">
      {loop.phase === 'active' && <button type="button" onClick={control('pause')}>Pause</button>}
      {loop.phase === 'paused' && <button type="button" onClick={control('resume')}>Resume</button>}
      {canRaise && <button type="button" onClick={control('raise-cap')}>Raise cap</button>}
      {loop.phase !== 'ended' && <button type="button" onClick={control('stop')}>Stop</button>}
      {/* An ended loop has nothing left to control, but its strip still sits
          over the pane's top line — and ended loops are persisted, so without
          this it would stay there across restarts until a new loop replaced
          it. Dismiss removes the ended record in main. */}
      {loop.phase === 'ended' && <button type="button" onClick={control('dismiss')}>Dismiss</button>}
    </span>
  </div>
  if (!latched) return strip
  return <>
    {strip}
    <div
      data-agent-code-interaction-owner="app"
      data-goal-loop-overlay=""
      role="dialog"
      aria-label="Agent goal loop"
      className="absolute inset-0 z-50 bg-canvas text-ink"
      onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
      onClick={event => event.stopPropagation()}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <p className="text-sm sm:text-base">Goal loop · {PHASE_LABEL[loop.phase]}{loop.phase === 'paused' ? ` · ${loop.pauseReason}` : ''}</p>
        <p className="max-w-xl whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{loop.goal}</p>
        <p className="text-xs">{describe(loop)} continuations · started {loop.startedAt}</p>
        {loop.completionSummary && <p className="max-w-xl text-xs">{loop.endReason}: {loop.completionSummary}</p>}
        <div className="flex gap-3 text-sm">
          {loop.phase === 'active' && <button type="button" onClick={control('pause')}>Pause</button>}
          {loop.phase === 'paused' && <button type="button" onClick={control('resume')}>Resume</button>}
          {canRaise && <button type="button" onClick={control('raise-cap')}>Raise cap to {raisedCap}</button>}
          {loop.phase !== 'ended' && <button type="button" onClick={control('stop')}>Stop</button>}
          {loop.phase === 'ended' && <button type="button" onClick={control('dismiss')}>Dismiss</button>}
          {/* The latch is one app-wide flag and this overlay is opaque over
              the whole pane, so it needs an exit that does not depend on
              remembering the chord. Escape is deliberately NOT bound here: in
              an agent pane Escape interrupts the running turn, and the
              capture-phase owner of that key is useKeybinds, not this pane. */}
          <button type="button" onClick={dismissGoalLoop}>Close</button>
        </div>
      </div>
    </div>
  </>
}
