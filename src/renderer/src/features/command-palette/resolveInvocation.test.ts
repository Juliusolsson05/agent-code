import { describe, expect, it } from 'vitest'

import {
  resolveCommandAvailability,
  resolveCommandInvocation,
  resolveCommandTarget,
  targetStillValid,
} from '@renderer/features/command-palette/resolveInvocation'
import { makeTestCommandContext } from '@renderer/features/command-palette/testing/commandContextHarness'
import type { CommandDef } from '@renderer/features/command-palette/types'

const base: CommandDef = {
  id: 'x.test',
  surface: 'app',
  title: 'Test',
  description: 'test',
  run: () => {},
}

describe('resolveCommandTarget', () => {
  it('resolves no target for a command that declares none', () => {
    // Inventing a target is worse than having none: it produces a confident
    // wrong answer, which is how an app-wide panel toggle started rendering
    // session-scoped state.
    expect(resolveCommandTarget(base, makeTestCommandContext())).toEqual({ kind: 'none' })
  })

  it('defaults a session-surface command to a session target', () => {
    const ctx = makeTestCommandContext({ focusedSessionId: 's1' })
    const command: CommandDef = { ...base, surface: 'session' }
    expect(resolveCommandTarget(command, ctx)).toEqual({ kind: 'session', id: 's1' })
  })

  it('resolves to none when a session command has no focused session', () => {
    // An empty or stale tiled lane returns null from the target resolver BY
    // DESIGN. That must surface as "no target", never as a fallback to some
    // other row the user is not looking at.
    const command: CommandDef = { ...base, surface: 'session' }
    expect(resolveCommandTarget(command, makeTestCommandContext())).toEqual({ kind: 'none' })
  })

  it('does not give an app command a session target even when one is focused', () => {
    const ctx = makeTestCommandContext({ focusedSessionId: 's1' })
    expect(resolveCommandTarget(base, ctx)).toEqual({ kind: 'none' })
  })

  it('resolves an explicit project target from the focused cwd', () => {
    const ctx = makeTestCommandContext({ focusedCwd: '/repo' })
    const command: CommandDef = { ...base, targetKind: 'project' }
    expect(resolveCommandTarget(command, ctx)).toEqual({ kind: 'project', id: '/repo' })
  })

  it('lets an explicit targetKind override the surface default', () => {
    const command: CommandDef = { ...base, surface: 'session', targetKind: 'app' }
    const ctx = makeTestCommandContext({ focusedSessionId: 's1' })
    expect(resolveCommandTarget(command, ctx)).toEqual({ kind: 'app' })
  })
})

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

describe('resolveCommandInvocation', () => {
  it('resolves target, availability, state and execute from one read', () => {
    const command: CommandDef = {
      ...base,
      surface: 'session',
      getState: () => ({ label: 'On' }),
    }
    const ctx = makeTestCommandContext({ focusedSessionId: 's1' })
    const invocation = resolveCommandInvocation(command, ctx)

    expect(invocation.commandId).toBe('x.test')
    expect(invocation.target).toEqual({ kind: 'session', id: 's1' })
    expect(invocation.availability).toEqual({ available: true })
    expect(invocation.state).toEqual({ label: 'On' })
  })

  it('does not evaluate state for an unavailable command', () => {
    // Evaluating getState for an excluded command was wasted work at best and
    // at worst read a target admission had just rejected.
    let evaluated = false
    const command: CommandDef = {
      ...base,
      when: () => false,
      getState: () => {
        evaluated = true
        return { label: 'x' }
      },
    }
    const invocation = resolveCommandInvocation(command, makeTestCommandContext())
    expect(invocation.state).toBeNull()
    expect(evaluated).toBe(false)
  })

  it('pins the target so a later focus change cannot retarget it', () => {
    // THE point of the phase. `execute` closes over the context the target was
    // resolved from, so moving focus afterwards cannot redirect the mutation.
    const seen: string[] = []
    const command: CommandDef = {
      ...base,
      surface: 'session',
      run: c => {
        seen.push(String(c.workspace.state.activeTabId))
      },
    }
    const ctx = makeTestCommandContext({ focusedSessionId: 's1', activeTabId: 'tab-a' })
    const invocation = resolveCommandInvocation(command, ctx)

    // Focus moves after resolution but before execution.
    const laterCtx = makeTestCommandContext({ focusedSessionId: 's2', activeTabId: 'tab-b' })
    void laterCtx

    void invocation.execute()
    expect(seen).toEqual(['tab-a'])
  })
})

describe('targetStillValid', () => {
  it('accepts a session that still exists', () => {
    const ctx = makeTestCommandContext({ focusedSessionId: 's1' })
    expect(targetStillValid({ kind: 'session', id: 's1' }, ctx)).toBe(true)
  })

  it('rejects a session that disappeared between pinning and mutation', () => {
    // The gap admission cannot cover: a destructive command may await a
    // confirmation modal or a kill round-trip, and the target can vanish in
    // that window. Rejecting is mandatory — falling back to whatever is focused
    // would let a confirmation granted for agent A authorize killing B.
    const ctx = makeTestCommandContext({ focusedSessionId: 's1' })
    expect(targetStillValid({ kind: 'session', id: 'gone' }, ctx)).toBe(false)
  })

  it('rejects a project target once focus moved to another project', () => {
    const ctx = makeTestCommandContext({ focusedCwd: '/other' })
    expect(targetStillValid({ kind: 'project', id: '/repo' }, ctx)).toBe(false)
  })

  it('accepts targets with no identity to invalidate', () => {
    const ctx = makeTestCommandContext()
    expect(targetStillValid({ kind: 'app' }, ctx)).toBe(true)
    expect(targetStillValid({ kind: 'none' }, ctx)).toBe(true)
  })
})
