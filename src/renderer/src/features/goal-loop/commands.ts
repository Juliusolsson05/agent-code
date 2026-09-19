import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggle } from '@renderer/features/command-palette/commandState'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { dismissGoalLoop, toggleGoalLoop, useGoalLoopView } from './viewState'

export const goalLoopCommands: CommandDef[] = [{
  id: 'goal-loop-preview', title: 'Goal Loop', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows the focused agent’s goal loop — goal, iteration budget and state — with pause, resume, raise-cap and stop controls.\n\n**Use when:** A loop is running and you want to check or steer it without typing.\n\n**Notes:** The strip above the pane is always visible while a loop exists. Loops are started by the agent through Goal Loop MCP; this surface only controls them, and says so when the agent has no loop. Press Escape, run it again, or switch away from the window to dismiss.',
  keywords: ['goal', 'loop', 'persistence', 'autonomous', 'pause', 'resume', 'stop', 'cap'],
  getState: () => toggle(useGoalLoopView.getState().latched),
  run: ({ ui }) => {
    ui.closePalette()
    toggleGoalLoop()
    // WHY a post-render check (#1021 review): the latch is app-wide, but only
    // visible agent panes render the overlay. With no visible pane (a
    // terminal-only or empty tab, or a hidden workspace), setting the latch
    // shows nothing. A lingering latch would then pop an overlay over the
    // next agent tab the user clicks into, long after they ran the command.
    // One frame is enough: the store change renders synchronously in React's
    // next commit, so if no overlay has mounted by then, none will, and the
    // latch meant nothing.
    if (!useGoalLoopView.getState().latched) return
    const settle = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0))
    settle(() => {
      if (useGoalLoopView.getState().latched && document.querySelector('[data-goal-loop-overlay]') == null) dismissGoalLoop()
    })
  },
}, {
  id: 'goal-loop-stop', title: 'Stop Goal Loop', category: 'session', surface: 'session',
  description: '**What it does:** Ends the focused agent’s active goal loop immediately (ended · cancelled).\n\n**Use when:** The loop should no longer continue.\n\n**Notes:** The agent can still finish its current turn; no further continuations are delivered.',
  keywords: ['goal', 'loop', 'stop', 'cancel', 'end'],
  when: ({ workspace }) => {
    const sessionId = commandTargetSessionId(workspace)
    return Boolean(sessionId && workspace.state.sessions[sessionId])
  },
  run: ({ ui, workspace }) => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) return
    ui.closePalette()
    void window.api.controlGoalLoop({ sessionId, action: 'stop' })
  },
}]
