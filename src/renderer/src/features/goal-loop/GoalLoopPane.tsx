import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop'
import { useAgentTerminalOwnerVisible } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { GoalLoopControlAction, GoalLoopState } from '@shared/types/goalLoop'
import { dismissGoalLoop, useGoalLoopView } from './viewState'
import { withVisibleControls } from '@shared/text/visibleControls'

const PHASE_LABEL: Record<GoalLoopState['phase'], string> = {
  active: 'active', paused: 'paused', ended: 'ended',
}

function describe(loop: GoalLoopState): string {
  const budget = `${loop.continuationsDelivered}/${loop.maxContinuations}`
  if (loop.phase === 'ended') return `ended (${loop.endReason})`
  if (loop.phase === 'paused') return `paused · ${loop.pauseReason} · ${budget}`
  return `iteration ${budget}`
}

// Buttons (plan M7): these were UNSTYLED <button>s — the browser's default
// look, no focus ring beyond the global outline — in a strip and an overlay
// the user reaches by keyboard. They are the shared Button now: ghost/xs in
// the pane-top strip, outline/sm on the overlay, Stop red-outline in both
// (it ends the loop), Close with the ⎋ chip Escape honours.

/** The latched overlay's shell, shared by the "loop" and "no loop" states so
 * both carry the SAME interaction-ownership marker and the same
 * `data-goal-loop-overlay` attribute. The keyboard router gates on that
 * attribute being mounted (#1021), so a latched state that renders any other
 * markup would reopen the invisible-trap bug. */
function GoalLoopOverlay({ children }: { children: ReactNode }) {
  // Keyboard ownership (K2-1). The overlay stamps the APP interaction-owner
  // marker and the router consumes every key while it is latched, so it has
  // to hold focus itself, or a keyboard user sees buttons they cannot reach:
  //   - on open, focus moves to the first action (rAF: the pane's own focus
  //     effects run in the same commit and would take it straight back);
  //   - Tab / Shift+Tab wrap inside, because focus that left this
  //     app-owning surface would land where the router admits no key;
  //   - on close, focus returns to whatever held it before (the composer,
  //     usually) instead of dropping to <body>.
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return <div
    ref={ref}
    data-agent-code-interaction-owner="app"
    data-goal-loop-overlay=""
    role="dialog"
    aria-label="Agent goal loop"
    className="absolute inset-0 z-50 bg-canvas text-ink"
    onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
      if (buttons.length === 0) return
      const index = buttons.indexOf(document.activeElement as HTMLElement)
      const last = buttons.length - 1
      const next = event.shiftKey ? (index <= 0 ? last : index - 1) : (index === last || index < 0 ? 0 : index + 1)
      // Only the wrap needs taking over; within the row the browser's own
      // Tab order is the same, but handling every Tab here keeps focus from
      // ever escaping when a button is disabled mid-press.
      event.preventDefault()
      buttons[next]?.focus()
    }}
  >
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      {children}
    </div>
  </div>
}

/** Mounts inside TldrPane's relative container (TileTree): a slim always-on
 * status strip while a loop exists for this session, plus the latched control
 * overlay. The strip keeps passive awareness — a running loop is visible
 * without opening anything; the overlay is where actions live. Both follow
 * TldrOverlay's input discipline: stop propagation so pane chrome never sees
 * the clicks, and theme tokens so they read in every theme. */
export function GoalLoopPane({ sessionId }: { sessionId: string }) {
  const [loop, setLoop] = useState<GoalLoopState | null>(null)
  // WHY the overlay also requires VISIBILITY, not just the latch (#1021
  // review): Reader, Spotlight, Settings and the fullscreen Global Editor
  // keep the whole workspace MOUNTED under display:none. An overlay rendered
  // there exists in the DOM, so the keyboard gate saw it and swallowed every
  // key, but nobody could see it. That is the same invisible trap, one level
  // down. The visibility context composes every enclosing hiding shell (see
  // AgentTerminalOwnership), so a hidden pane renders no overlay, and the
  // router treats the latch as stale instead.
  const visible = useAgentTerminalOwnerVisible()
  const latched = useGoalLoopView(state => state.latched) && visible
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
  if (!loop) {
    if (!latched) return null
    // #1021: the latch is app-wide and running the command is an explicit
    // request to see this surface, so it must visibly answer even when this
    // agent has no loop, which is the normal case since only an agent starts
    // one. Rendering nothing here was half of the freeze: the router gated
    // input on a surface the user could not see. TldrOverlay answers the same
    // way ("No TLDR yet"). A loop being read for the first time also lands
    // here briefly. That is acceptable: the overlay is up, it explains itself,
    // and it swaps to the real loop the moment the read resolves.
    return <GoalLoopOverlay>
      <p className="text-sm sm:text-base">No goal loop on this agent</p>
      <p className="max-w-xl text-xs">An agent starts a goal loop through Goal Loop MCP.</p>
      <div className="flex gap-3 text-sm">
        {/* Escape dismisses the latch (useKeybinds' goal-loop gate), so the
            button carries the chip instead of the prose saying so (plan M7). */}
        <Button type="button" variant="ghost" size="sm" onClick={dismissGoalLoop}>Close<Kbd binding="Escape" /></Button>
      </div>
    </GoalLoopOverlay>
  }
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
    {/* The goal is agent-authored and sits beside Resume, Raise cap and Stop
        — the controls that grant it more turns (#1049 re-review). */}
    <span className="truncate">Goal loop · {PHASE_LABEL[loop.phase]} · {describe(loop)} · {withVisibleControls(loop.goal)}</span>
    <span className="flex shrink-0 gap-2">
      {loop.phase === 'active' && <Button type="button" variant="ghost" size="xs" onClick={control('pause')}>Pause</Button>}
      {loop.phase === 'paused' && <Button type="button" variant="ghost" size="xs" onClick={control('resume')}>Resume</Button>}
      {canRaise && <Button type="button" variant="ghost" size="xs" onClick={control('raise-cap')}>Raise Cap</Button>}
      {loop.phase !== 'ended' && <Button type="button" variant="destructive-outline" size="xs" onClick={control('stop')}>Stop</Button>}
      {/* An ended loop has nothing left to control, but its strip still sits
          over the pane's top line — and ended loops are persisted, so without
          this it would stay there across restarts until a new loop replaced
          it. Dismiss removes the ended record in main. */}
      {loop.phase === 'ended' && <Button type="button" variant="ghost" size="xs" onClick={control('dismiss')}>Dismiss</Button>}
    </span>
  </div>
  if (!latched) return strip
  return <>
    {strip}
    <GoalLoopOverlay>
        <p className="text-sm sm:text-base">Goal loop · {PHASE_LABEL[loop.phase]}{loop.phase === 'paused' ? ` · ${loop.pauseReason}` : ''}</p>
        <p className="max-w-xl whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{withVisibleControls(loop.goal)}</p>
        <p className="text-xs">{describe(loop)} continuations · started {loop.startedAt}</p>
        {loop.completionSummary && <p className="max-w-xl text-xs">{loop.endReason}: {withVisibleControls(loop.completionSummary)}</p>}
        <div className="flex gap-3 text-sm">
          {loop.phase === 'active' && <Button type="button" variant="outline" size="sm" onClick={control('pause')}>Pause</Button>}
          {loop.phase === 'paused' && <Button type="button" variant="outline" size="sm" onClick={control('resume')}>Resume</Button>}
          {canRaise && <Button type="button" variant="outline" size="sm" onClick={control('raise-cap')}>Raise Cap to {raisedCap}</Button>}
          {loop.phase !== 'ended' && <Button type="button" variant="destructive-outline" size="sm" onClick={control('stop')}>Stop</Button>}
          {loop.phase === 'ended' && <Button type="button" variant="outline" size="sm" onClick={control('dismiss')}>Dismiss</Button>}
          {/* The latch is one app-wide flag and this overlay is opaque over
              the whole pane, so it needs an exit that does not depend on
              remembering the chord. Escape is deliberately NOT bound here: in
              an agent pane Escape interrupts the running turn, and the
              capture-phase owner of that key is useKeybinds, not this pane. */}
          <Button type="button" variant="ghost" size="sm" onClick={dismissGoalLoop}>Close<Kbd binding="Escape" /></Button>
        </div>
    </GoalLoopOverlay>
  </>
}
