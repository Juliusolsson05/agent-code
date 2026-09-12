import { describe, expect, it } from 'vitest'

import type { AppStore } from '@renderer/app-state/types'
import { agentNameForSession, resolveAgentName } from '@renderer/workspace/agentNames/selectors'

const names = { 'identity-one': 'Apollo' }

describe('agent name selector', () => {
  it('returns the allocated name for an enabled agent', () => {
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'identity-one' }, names }))
      .toBe('Apollo')
  })

  it('shows nothing while the setting is off, without forgetting the assignment', () => {
    expect(resolveAgentName({ enabled: false, meta: { kind: 'claude', agentNameId: 'identity-one' }, names }))
      .toBeNull()
  })

  it('names a shell terminal from the same pool (#865)', () => {
    // A named shell is routable since the operator gained terminals.input
    // (#793): the guide sends a spoken shell name to terminals.input, never
    // agents.prompt. The old "unroutable target" reason no longer holds.
    expect(resolveAgentName({ enabled: true, meta: { kind: 'terminal', agentNameId: 'identity-one' }, names }))
      .toBe('Apollo')
  })

  it('treats a missing provider kind as the default agent provider', () => {
    // Pre-terminal workspace blobs omit `kind`; the rest of the app reads that
    // as Claude, and naming must not disagree with placement or the same agent
    // would be addressable in search and unnamed in its header.
    expect(resolveAgentName({ enabled: true, meta: { agentNameId: 'identity-one' }, names }))
      .toBe('Apollo')
  })

  it('shows nothing before an identity is claimed or an allocation arrives', () => {
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude' }, names })).toBeNull()
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'unknown' }, names })).toBeNull()
    expect(resolveAgentName({ enabled: true, meta: undefined, names })).toBeNull()
  })

  it('never returns an inherited prototype value as a name', () => {
    // Identities come from a user-editable workspace file. Reading
    // names['constructor'] off a plain object would hand a Function to the
    // renderer and to agents.search.
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'constructor' }, names }))
      .toBeNull()
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'toString' }, names }))
      .toBeNull()
  })

  it('degrades to no name on a store that has no workspace keys at all', () => {
    // The phone's store stub is `{ settings }` and nothing else, and the alias
    // that installs it is invisible to tsc — so this is the only compile-time
    // -adjacent gate on the shape `agentNameForSession` may assume. It must
    // return null, not throw. Several renderer specs mock the store this way
    // too, so a throw here would break tests that have nothing to do with names.
    const phoneShaped = { settings: { agentNamesEnabled: false } } as unknown as AppStore
    expect(() => agentNameForSession(phoneShaped, 'any-session')).not.toThrow()
    expect(agentNameForSession(phoneShaped, 'any-session')).toBeNull()

    const empty = {} as unknown as AppStore
    expect(() => agentNameForSession(empty, 'any-session')).not.toThrow()
    expect(agentNameForSession(empty, 'any-session')).toBeNull()
  })
})
