import { afterEach, describe, expect, it, vi } from 'vitest'

import { getEffectiveAgentSurface, providerHasNoNativeTerminal } from '@renderer/workspace/agentDisplayMode'
import { resolveRemoteConnectionId } from '@renderer/workspace/remoteConnection'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { HERMES_ATTENTION_CONDITION_KINDS } from '@shared/types/providerConditionAttention'
import { isChatSurfaceProviderKind } from '@shared/types/providerKind'

// The read-time predicates a Hermes pane (#1482) depends on. The exhaustive
// registries make the KIND safe; these decide what the pane mounts and which
// server it talks to, and review b found each could be broken silently.

const originalApi = window.api
afterEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

describe('Hermes pane predicates', () => {
  it('is a chat surface with no native terminal, pinned to the agent view', () => {
    expect(isChatSurfaceProviderKind('hermes')).toBe(true)
    expect(isChatSurfaceProviderKind('claude')).toBe(false)
    expect(providerHasNoNativeTerminal('hermes', undefined)).toBe(true)
    expect(providerHasNoNativeTerminal('claude', undefined)).toBe(false)
    // Even a Terminal view preference cannot mount a dead terminal.
    expect(getEffectiveAgentSurface({ kind: 'hermes', mode: 'terminal', runtime: emptyRuntime() })).not.toBe('terminal')
  })

  it('reopens a pane on its own persisted connection before any default', async () => {
    const list = vi.fn(async () => [{ id: 'other', state: 'ready' }])
    Object.defineProperty(window, 'api', { configurable: true, value: { hermesList: list } })
    expect(await resolveRemoteConnectionId('hermes', 'mine')).toBe('mine')
    expect(list).not.toHaveBeenCalled()
    // No persisted choice: the first signed-in connection, then any.
    Object.defineProperty(window, 'api', { configurable: true, value: { hermesList: async () => [{ id: 'a', state: 'signed-out' }, { id: 'b', state: 'ready' }] } })
    expect(await resolveRemoteConnectionId('hermes', undefined)).toBe('b')
    // A local kind never has one.
    expect(await resolveRemoteConnectionId('claude', 'mine')).toBeUndefined()
  })

  it('counts every Hermes request as needing the user (they block the remote agent)', () => {
    for (const kind of ['hermes.approval', 'hermes.clarify', 'hermes.sudo', 'hermes.secret']) {
      expect(HERMES_ATTENTION_CONDITION_KINDS.has(kind)).toBe(true)
    }
  })
})
