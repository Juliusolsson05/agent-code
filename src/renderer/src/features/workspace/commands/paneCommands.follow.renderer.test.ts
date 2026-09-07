import { describe, expect, it } from 'vitest'

import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'

// Guards the command-availability half of terminal follow: both commands
// previously carried `renderedViewPolicy: 'requires-rendered-feed'`, which
// `commandAllowedByRenderedViewPolicy` resolves to false on ANY terminal
// surface — and unconditionally for OpenCode Terminal sessions
// (providerRuntime === 'terminal'). Someone re-adding the policy "for
// consistency" would silently uninstall the commands from raw terminal views
// again while the leaf-side behavior stays green.
//
// WHY this does not exercise `when`: the kind guards route through
// `commandTargetSessionId`, which needs a much larger workspace-state shape
// (tab/dispatch focus) than a unit fixture should fake. This task does not
// touch `when`; its behavior is owned by the existing command suites.

describe('follow command availability', () => {
  const tail = paneCommands.find(command => command.id === 'toggle-tail')
  const jump = paneCommands.find(command => command.id === 'jump-latest-message')

  it('exposes both follow commands without a rendered-view policy', () => {
    expect(tail).toBeDefined()
    expect(jump).toBeDefined()
    expect(tail!.renderedViewPolicy).toBeUndefined()
    expect(jump!.renderedViewPolicy).toBeUndefined()
  })

  it('keeps both commands shell-excluded through a kind guard', () => {
    // The `when` guards (kind !== 'terminal') are what keep plain shells out;
    // assert they exist so removing the policy cannot silently remove them.
    expect(typeof tail!.when).toBe('function')
    expect(typeof jump!.when).toBe('function')
  })
})
