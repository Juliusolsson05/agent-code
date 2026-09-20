import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'

const snapshot: ProviderEnablementSnapshot = {
  entries: [
    { kind: 'claude', enabled: true, because: 'detected', installed: true },
    { kind: 'codex', enabled: true, because: 'detected', installed: true },
    { kind: 'opencode', enabled: false, because: 'user', installed: true },
    { kind: 'grok', enabled: false, because: 'not-detected', installed: false },
  ],
  opencodeUsageSource: 'none',
}

describe('provider enablement store', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  let changedCb: ((snapshot: ProviderEnablementSnapshot) => void) | null = null

  beforeEach(() => {
    changedCb = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        providerEnablementGet: vi.fn().mockResolvedValue(snapshot),
        onProviderEnablementChanged: vi.fn().mockImplementation(cb => {
          changedCb = cb
          return () => {}
        }),
      },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    vi.restoreAllMocks()
  })

  it('seeds from the initial fetch and follows push updates', async () => {
    const {
      useProviderEnablementStore,
      useProviderEnablementSync,
      useEnabledAgentProviderKinds,
    } = await import('./store')

    const { result: sync } = renderHook(() => useProviderEnablementSync())
    void sync
    await act(async () => {
      await Promise.resolve()
    })

    expect(useProviderEnablementStore.getState().snapshot).toEqual(snapshot)
    const enabled = renderHook(() => useEnabledAgentProviderKinds()).result.current
    expect([...enabled]).toEqual(['claude', 'codex'])

    await act(async () => {
      changedCb?.({
        ...snapshot,
        entries: snapshot.entries.map(e => ({ ...e, enabled: e.kind !== 'codex' })),
      })
    })
    const enabledAfterPush = renderHook(() => useEnabledAgentProviderKinds()).result.current
    // The push disabled only codex; fail-open kinds (claude/opencode/grok)
    // remain, and opencode stays enabled even though its override was 'user
    // off' in the FIRST snapshot — the push replaces the whole snapshot.
    expect([...enabledAfterPush]).toEqual(['claude', 'opencode', 'grok'])
  })

  it('fails open (all enabled) before the first snapshot lands', async () => {
    const { useProviderEnablementStore, enabledAgentProviderKindsSnapshot } = await import('./store')
    useProviderEnablementStore.setState({ snapshot: null })
    expect(enabledAgentProviderKindsSnapshot().size).toBe(4)
  })
})
