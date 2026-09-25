import { describe, expect, it } from 'vitest'

import {
  resolveCommandAvailability,
} from '@renderer/features/command-palette/resolveInvocation'
import { toggle } from '@renderer/features/command-palette/commandState'
import { makeTestCommandContext } from '@renderer/features/command-palette/testing/commandContextHarness'
import type { CommandDef } from '@renderer/features/command-palette/types'

const base: CommandDef = {
  id: 'x.test',
  surface: 'app',
  title: 'Test',
  description: 'test',
  run: () => {},
}

describe('resolveCommandAvailability', () => {
  it('lets every surviving surface reach its own when — no mode gate (#992)', () => {
    // Unified layout: `grid`/`dispatch` surfaces died with the modes. A
    // workspace command's availability is its own `when` (target exists?),
    // never "which layout is active" — the old mode-hide test that lived
    // here pinned behavior the merge deleted.
    const command: CommandDef = { ...base, surface: 'workspace' }
    expect(resolveCommandAvailability(command, makeTestCommandContext())).toEqual({
      available: true,
    })
    expect(
      resolveCommandAvailability(
        { ...command, when: () => false },
        makeTestCommandContext(),
      ),
    ).toEqual({ available: false, reason: 'Not available right now', presentation: 'hide' })
  })

  it('lets a command upgrade a silent hide into an explained disable', () => {
    // The discovery-worthy case: someone searching for a provider-unsupported
    // command deserves a greyed row that says why, not silence.
    const command: CommandDef = {
      ...base,
      when: () => false,
      unavailableReason: () => ({
        reason: 'OpenCode has no transcript adapter',
        presentation: 'disable',
      }),
    }
    expect(resolveCommandAvailability(command, makeTestCommandContext())).toEqual({
      available: false,
      reason: 'OpenCode has no transcript adapter',
      presentation: 'disable',
    })
  })

  it('hides a generic when-failure that does not explain itself', () => {
    const command: CommandDef = { ...base, when: () => false }
    expect(resolveCommandAvailability(command, makeTestCommandContext())).toEqual({
      available: false,
      reason: 'Not available right now',
      presentation: 'hide',
    })
  })

  it('reports availability when nothing objects', () => {
    expect(resolveCommandAvailability(base, makeTestCommandContext())).toEqual({ available: true })
  })
})
