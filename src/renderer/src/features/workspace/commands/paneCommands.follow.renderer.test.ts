import { describe, expect, it } from 'vitest'

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
