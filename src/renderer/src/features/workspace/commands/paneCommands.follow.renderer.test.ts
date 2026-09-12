import { describe, expect, it, vi } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { describeCommandState } from '@renderer/features/command-palette/commandState'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'

// Guards the command-availability half of terminal follow: both commands
// previously carried `renderedViewPolicy: 'requires-rendered-feed'`, which
// `commandAllowedByRenderedViewPolicy` resolves to false on ANY terminal
// surface — and unconditionally for OpenCode Terminal sessions
// (providerRuntime === 'terminal'). Someone re-adding the policy "for
// consistency" would silently uninstall the commands from raw terminal views
// again while the leaf-side behavior stays green.

// The state shape `commandTargetSessionIdForState` needs to resolve a target
// (mirror of contextWithAgent() in sessionCommands.renderer.test.ts — active
// tab with a focused leaf). Without it the selector returns null and `when`
// answers false for every kind, which would make this guard vacuous.
function contextWithKind(kind: string): CommandContext {
  return {
    workspace: {
      state: {
        activeTabId: 'tab',
        dispatchMode: null,
        sessions: {
          agent: { cwd: '/projects/app', kind, providerSessionId: 'provider-abc' },
        },
        tabs: [{ id: 'tab', focusedSessionId: 'agent', root: { type: 'leaf', sessionId: 'agent' } }],
      },
    },
    ui: {},
    flags: {},
  } as unknown as CommandContext
}

describe('follow command availability', () => {
  const tail = paneCommands.find(command => command.id === 'toggle-tail')
  const jump = paneCommands.find(command => command.id === 'jump-latest-message')

  it('exposes both follow commands without a rendered-view policy', () => {
    expect(tail).toBeDefined()
    expect(jump).toBeDefined()
    expect(tail!.renderedViewPolicy).toBeUndefined()
    expect(jump!.renderedViewPolicy).toBeUndefined()
  })

  it('offers both follow commands for plain shell terminals as well as every agent kind (#865)', () => {
    // Plain terminals follow through the same xterm hook as agent terminal
    // views now; there is no kind left for which these commands are inert.
    for (const command of [tail!, jump!]) {
      for (const kind of ['terminal', 'claude', 'codex', 'opencode']) {
        expect(command.when?.(contextWithKind(kind))).toBe(true)
      }
    }
  })
})


describe('working-agent follow command', () => {
  it('is a window-wide toggle available without a running target or rendered view', () => {
    const command = paneCommands.find(row => row.id === 'toggle-tail-working')!
    const context = contextWithKind('claude')
    const toggle = vi.fn()
    context.ui.toggleTailWorkingMode = toggle
    context.flags.tailWorkingMode = false
    expect(command.surface).toBe('app')
    expect(command.when).toBeUndefined()
    expect(command.renderedViewPolicy).toBeUndefined()
    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'off' })
    command.run(context)
    expect(toggle).toHaveBeenCalledTimes(1)
    context.flags.tailWorkingMode = true
    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'on' })
  })

  it('reports effective focused follow only for eligible agents and identifies the owning mode', () => {
    const command = paneCommands.find(row => row.id === 'toggle-tail')!
    const context = contextWithKind('claude')
    context.flags.tailWorkingMode = true
    const runtime = emptyRuntime()
    context.workspace.getRuntime = () => runtime
    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'off' })
    runtime.sessionStatus = 'running'
    expect(describeCommandState(command.getState!(context)).detail).toBe('On via Auto-follow All Working Agents')
    context.workspace.state.sessions.agent.kind = 'terminal'
    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'off' })
    runtime.tailMode = true
    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'on' })
  })
})
