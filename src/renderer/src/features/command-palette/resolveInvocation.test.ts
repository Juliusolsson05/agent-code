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
  it('hides a mode-irrelevant command without explaining', () => {
    // Product decision: a grid-spatial command in Dispatch points at a layout
    // the user cannot see. Explaining that on every mode switch is noise.
    const command: CommandDef = { ...base, surface: 'grid' }
    const ctx = makeTestCommandContext({ flags: { dispatchModeEnabled: true } })
    expect(resolveCommandAvailability(command, ctx)).toEqual({
      available: false,
      reason: 'Not applicable in this layout',
      presentation: 'hide',
    })
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

  it('checks the surface before consulting an explicit reason', () => {
    // Order is the product decision: a command must not be able to force
    // itself visible in a layout where its concept does not exist.
    const command: CommandDef = {
      ...base,
      surface: 'grid',
      unavailableReason: () => ({ reason: 'should not win', presentation: 'disable' }),
    }
    const ctx = makeTestCommandContext({ flags: { dispatchModeEnabled: true } })
    expect(resolveCommandAvailability(command, ctx)).toMatchObject({ presentation: 'hide' })
  })
})
