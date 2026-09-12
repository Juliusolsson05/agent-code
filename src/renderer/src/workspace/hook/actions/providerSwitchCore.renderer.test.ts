import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { switchAgentProvider } from '@renderer/workspace/hook/actions/providerSwitchCore'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('switchAgentProvider', () => {
  it('wakes a durable source pane before main can request native compaction', async () => {
    const switchProvider = vi.fn().mockResolvedValue({
      kind: 'switched',
      targetKind: 'codex',
      targetProviderSessionId: 'target-provider-session',
      targetFilePath: '/project/target.jsonl',
      compactedBeforeSwitch: true,
      truncatedBeforeSwitch: false,
    })
    const replaceSession = vi.fn().mockResolvedValue('target-pane')
    const unsubscribe = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onProviderSwitchProgress: vi.fn(() => unsubscribe),
        switchProvider,
      },
    })

    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'claude',
              providerSessionId: 'source-provider-session',
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: ['workflows'] },
    } as unknown as WorkspaceRefs
    const ensureSessionLive = vi.fn(async () => {
      // Waking under Claude filters the Workflow default out of canonical
      // source metadata. The original undefined provenance must nevertheless
      // let the target Codex session inherit that default.
      return { sessionId: 'source-pane', builtInMcpDomains: [] }
    })
    const sessionActions = {
      ensureSessionLive,
      replaceSession,
    } as unknown as SessionActions
    // Runtime updates are irrelevant to this transaction-order regression. The
    // real setter can legitimately find no runtime while a detached pane wakes,
    // so preserving an empty map also exercises that supported shape.
    let runtimes = {}
    const setRuntimes = ((next: typeof runtimes | ((value: typeof runtimes) => typeof runtimes)) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
    }) as WorkspaceSetRuntimes

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'codex',
      refs,
      setRuntimes,
      sessionActions,
    })).resolves.toEqual({
      status: 'switched',
      newSessionId: 'target-pane',
      targetKind: 'codex',
    })

    expect(ensureSessionLive).toHaveBeenCalledWith('source-pane', 'provider-switch.wake-source')
    expect(switchProvider).toHaveBeenCalledWith({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-provider-session',
      sourceSessionId: 'source-pane',
      cwd: '/project',
    })
    expect(ensureSessionLive.mock.invocationCallOrder[0]).toBeLessThan(
      switchProvider.mock.invocationCallOrder[0]!,
    )
    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'codex',
      resumeSessionId: 'target-provider-session',
      preserveTldr: true,
      targetSessionId: 'source-pane',
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not enter provider-switch IPC when the dead source cannot be recovered', async () => {
    const ensureSessionLive = vi.fn().mockRejectedValue(new Error('Claude could not resume'))
    const switchProvider = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onProviderSwitchProgress: vi.fn(),
        switchProvider,
      },
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'claude',
              providerSessionId: 'source-provider-session',
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs

    const result = await switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'codex',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive,
      } as unknown as SessionActions,
    })

    expect(result).toEqual({ status: 'failed', message: 'Claude could not resume' })
    expect(switchProvider).not.toHaveBeenCalled()
  })

  it('replaces a durable OpenCode session whose exported transcript is still empty', async () => {
    const switchProvider = vi.fn().mockResolvedValue({
      kind: 'source-empty',
      targetKind: 'claude',
    })
    const replaceSession = vi.fn().mockResolvedValue('target-pane')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onProviderSwitchProgress: vi.fn(() => vi.fn()),
        switchProvider,
      },
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'opencode',
              providerRuntime: 'terminal',
              providerSessionId: 'ses_precreated_but_empty',
              builtInMcpDomains: ['orchestration'],
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs
    const ensureSessionLive = vi.fn(async () => ({
      sessionId: 'source-pane',
      builtInMcpDomains: ['orchestration'],
    }))

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'claude',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive,
        replaceSession,
      } as unknown as SessionActions,
    })).resolves.toEqual({
      status: 'switched',
      newSessionId: 'target-pane',
      targetKind: 'claude',
      // An empty source loses nothing on the way across, so the strategy the
      // batch summary counts is `native` even though no transcript was
      // translated at all (#821).
      strategy: 'native',
      shrinkSummary: null,
    })

    expect(switchProvider).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'opencode',
      targetKind: 'claude',
      sourceProviderSessionId: 'ses_precreated_but_empty',
    }))
    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'claude',
      targetSessionId: 'source-pane',
    })
  })

  it('carries an OpenCode Terminal destination into the replacement runtime', async () => {
    const replaceSession = vi.fn().mockResolvedValue('target-pane')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {},
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': { cwd: '/project', kind: 'claude' },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'opencode',
      targetProviderRuntime: 'terminal',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: { replaceSession } as unknown as SessionActions,
    })).resolves.toMatchObject({ status: 'switched', targetKind: 'opencode' })

    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'opencode',
      providerRuntime: 'terminal',
      targetSessionId: 'source-pane',
    })
  })

  it('carries an OpenCode Terminal destination through a durable transcript switch', async () => {
    const switchProvider = vi.fn().mockResolvedValue({
      kind: 'switched',
      targetKind: 'opencode',
      targetProviderSessionId: 'ses_translated_target',
      targetFilePath: '/project/target.json',
      compactedBeforeSwitch: false,
      truncatedBeforeSwitch: false,
    })
    const replaceSession = vi.fn().mockResolvedValue('target-pane')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onProviderSwitchProgress: vi.fn(() => vi.fn()),
        switchProvider,
      },
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'claude',
              providerSessionId: 'claude-source-session',
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs
    const ensureSessionLive = vi.fn(async () => ({
      sessionId: 'source-pane',
      builtInMcpDomains: [],
    }))

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'opencode',
      targetProviderRuntime: 'terminal',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive,
        replaceSession,
      } as unknown as SessionActions,
    })).resolves.toEqual({
      status: 'switched',
      newSessionId: 'target-pane',
      targetKind: 'opencode',
    })

    expect(switchProvider).toHaveBeenCalledWith({
      sourceKind: 'claude',
      targetKind: 'opencode',
      sourceProviderSessionId: 'claude-source-session',
      sourceSessionId: 'source-pane',
      cwd: '/project',
    })
    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'opencode',
      providerRuntime: 'terminal',
      resumeSessionId: 'ses_translated_target',
      preserveTldr: true,
      targetSessionId: 'source-pane',
    })
  })

  it('rejects stale or undeclared runtime edges before creating a transcript', async () => {
    const replaceSession = vi.fn()
    const switchProvider = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { switchProvider },
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'opencode',
              providerSessionId: 'ses_source',
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'opencode',
      targetProviderRuntime: 'terminal',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: { replaceSession } as unknown as SessionActions,
    })).resolves.toMatchObject({ status: 'skipped' })

    expect(switchProvider).not.toHaveBeenCalled()
    expect(replaceSession).not.toHaveBeenCalled()
  })

  // Arrival compaction (#821 Stage 5). The renderer half is what decides WHEN
  // the target is asked to compact itself, and it is deliberately
  // fire-and-forget — so the switch result must not depend on it, and its
  // progress must land on the NEW pane rather than the pane that no longer
  // exists.

  it('asks the new Claude pane to compact on arrival and reports its failure without failing the switch', async () => {
    const switchProvider = vi.fn().mockResolvedValue({
      kind: 'switched',
      targetKind: 'claude',
      targetProviderSessionId: 'target-provider-session',
      targetFilePath: '/project/target.jsonl',
      compactedBeforeSwitch: false,
      truncatedBeforeSwitch: false,
      strategy: 'raw',
      shrinkSummary: null,
    })
    const replaceSession = vi.fn().mockResolvedValue('target-pane')
    const compactAfterSwitch = vi.fn().mockResolvedValue({ ok: false, message: 'Claude did not accept /compact: composer unavailable' })
    // One unsubscribe per subscription, kept apart so the assertions can prove
    // BOTH are torn down — the switch's own (source-scoped) and the arrival's
    // (new-pane-scoped).
    const unsubscribes: Array<() => void> = []
    const progressListeners: Array<(event: { sourceSessionId: string; phase: string; message: string }) => void> = []
    const onProviderSwitchProgress = vi.fn((cb: (event: { sourceSessionId: string; phase: string; message: string }) => void) => {
      progressListeners.push(cb)
      const unsubscribe = vi.fn()
      unsubscribes.push(unsubscribe)
      return unsubscribe
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { onProviderSwitchProgress, switchProvider, compactAfterSwitch },
    })

    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'codex',
              providerSessionId: 'codex-source-session',
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs
    const sessionActions = {
      ensureSessionLive: vi.fn(async () => ({ sessionId: 'source-pane', builtInMcpDomains: [] })),
      replaceSession,
    } as unknown as SessionActions
    let runtimes: Record<string, unknown> = {
      'target-pane': { providerSwitch: null },
    }
    const setRuntimes = ((next: typeof runtimes | ((value: typeof runtimes) => typeof runtimes)) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
    }) as WorkspaceSetRuntimes
    const onArrivalFailure = vi.fn()

    const result = await switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'claude',
      refs,
      setRuntimes,
      sessionActions,
      contextPolicy: { compactOnArrival: true },
      onArrivalFailure,
    })

    // The switch itself succeeded and says nothing about the follow-up.
    expect(result).toMatchObject({ status: 'switched', newSessionId: 'target-pane' })
    // Addressed to the NEW pane, with the target transcript the switch wrote.
    expect(compactAfterSwitch).toHaveBeenCalledWith({
      sessionId: 'target-pane',
      targetKind: 'claude',
      cwd: '/project',
      providerSessionId: 'target-provider-session',
    })
    expect(compactAfterSwitch.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(replaceSession.mock.invocationCallOrder[0]!)

    // The second subscription filters on the new session id: an event for the
    // pane that no longer exists must not write runtime state for the new one.
    expect(onProviderSwitchProgress).toHaveBeenCalledTimes(2)
    const arrivalListener = progressListeners[1]!
    arrivalListener({ sourceSessionId: 'source-pane', phase: 'compacting', message: 'ignored' })
    expect(runtimes['target-pane']).toMatchObject({ providerSwitch: null })
    arrivalListener({ sourceSessionId: 'target-pane', phase: 'compacting', message: 'Compacting…' })
    expect(runtimes['target-pane']).toMatchObject({
      providerSwitch: { phase: 'compacting', message: 'Compacting…' },
    })

    // The reported failure reaches the caller's toast hook, and both
    // subscriptions are released once the arrival promise settles.
    await vi.waitFor(() => {
      expect(onArrivalFailure).toHaveBeenCalledWith('Claude did not accept /compact: composer unavailable')
      // Teardown runs in the arrival promise's `finally`, a couple of
      // microtasks after the failure is reported, so it is polled with it
      // rather than asserted straight after.
      expect(unsubscribes).toHaveLength(2)
      for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledOnce()
    })
    expect(runtimes['target-pane']).toMatchObject({ providerSwitch: null })
  })

  it('refuses a second switch while the pane is still compacting on arrival', async () => {
    // The gap `providerSwitchesInFlight` cannot cover: that Set is keyed on the
    // pane a switch starts FROM and is released when the transaction resolves,
    // which is before the arrival compaction it kicked off has finished — and
    // that compaction runs on the NEW pane id. Only `runtime.providerSwitch`
    // still says the pane is inside a provider-switch operation.
    const switchProvider = vi.fn()
    const replaceSession = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onProviderSwitchProgress: vi.fn(() => vi.fn()),
        switchProvider,
      },
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'target-pane': {
              cwd: '/project',
              kind: 'claude',
              providerSessionId: 'claude-target-session',
            },
          },
        },
      },
      latestRuntimesRef: {
        current: {
          'target-pane': {
            // Exactly what `startArrivalCompaction` writes from the main
            // process's progress events, on a pane that is otherwise idle:
            // the switch already committed, so nothing else here reads busy.
            providerSwitch: { phase: 'compacting', message: 'Compacting the imported history with Claude…' },
            processActive: false,
            semantic: { currentTurn: null },
          },
        },
      },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs

    await expect(switchAgentProvider({
      sessionId: 'target-pane',
      targetKind: 'codex',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive: vi.fn(),
        replaceSession,
      } as unknown as SessionActions,
    })).resolves.toEqual({
      // 'skipped', not 'failed'. Nothing is wrong with this pane — it is busy
      // with an operation that ends on its own, and trying again shortly is
      // the whole remedy. Reporting it as a failure made a bulk return during
      // arrival compaction, which is the DEFAULT for large conversations and
      // holds this flag for minutes per pane, announce "Returned 0 agents (20
      // failed)" for a batch where every agent was merely busy. The string is
      // unchanged and still reaches the same pane toast.
      status: 'skipped',
      reason: 'This pane is still finishing a provider switch — wait for it to complete',
    })

    expect(switchProvider).not.toHaveBeenCalled()
    expect(replaceSession).not.toHaveBeenCalled()
  })

  it('does not ask a Codex target to compact on arrival', async () => {
    // Arrival compaction is Claude-only by design (Codex auto-compacts at its
    // own threshold, and the projection is written below it). The guard lives
    // at this call site, so it needs its own case.
    const switchProvider = vi.fn().mockResolvedValue({
      kind: 'switched',
      targetKind: 'codex',
      targetProviderSessionId: 'target-provider-session',
      targetFilePath: '/project/target.jsonl',
      compactedBeforeSwitch: false,
      truncatedBeforeSwitch: false,
      strategy: 'native',
      shrinkSummary: null,
    })
    const compactAfterSwitch = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onProviderSwitchProgress: vi.fn(() => vi.fn()),
        switchProvider,
        compactAfterSwitch,
      },
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'claude',
              providerSessionId: 'claude-source-session',
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: [] },
    } as unknown as WorkspaceRefs

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'codex',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive: vi.fn(async () => ({ sessionId: 'source-pane', builtInMcpDomains: [] })),
        replaceSession: vi.fn().mockResolvedValue('target-pane'),
      } as unknown as SessionActions,
      contextPolicy: { compactOnArrival: true },
    })).resolves.toMatchObject({ status: 'switched' })

    expect(compactAfterSwitch).not.toHaveBeenCalled()
  })
})
