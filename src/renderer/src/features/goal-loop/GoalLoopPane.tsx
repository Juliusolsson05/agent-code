import { useEffect, useState } from 'react'
import type { GoalLoopState } from '@shared/types/goalLoop'
import { useGoalLoopView } from './viewState'

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
  const control = (action: 'pause' | 'resume' | 'stop' | 'raise-cap') => () => {
    void window.api.controlGoalLoop({
      sessionId, action,
      value: action === 'raise-cap' ? loop.maxContinuations + 25 : undefined,
    })
  }
  const strip = <div
    data-agent-code-interaction-owner="app"
    data-goal-loop-strip=""
    className="pointer-events-auto absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-2 bg-canvas/90 px-3 py-1 text-xs text-ink"
    onMouseDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
  >
    <span className="truncate">Goal loop · {PHASE_LABEL[loop.phase]} · {describe(loop)} · {loop.goal}</span>
    <span className="flex shrink-0 gap-2">
      {loop.phase === 'active' && <button type="button" onClick={control('pause')}>Pause</button>}
      {loop.phase === 'paused' && <button type="button" onClick={control('resume')}>Resume</button>}
      {loop.phase === 'paused' && loop.pauseReason === 'cap' && <button type="button" onClick={control('raise-cap')}>Raise cap</button>}
      {loop.phase !== 'ended' && <button type="button" onClick={control('stop')}>Stop</button>}
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
          {loop.phase === 'paused' && loop.pauseReason === 'cap' && <button type="button" onClick={control('raise-cap')}>Raise cap +25</button>}
          {loop.phase !== 'ended' && <button type="button" onClick={control('stop')}>Stop</button>}
        </div>
      </div>
    </div>
  </>
}
