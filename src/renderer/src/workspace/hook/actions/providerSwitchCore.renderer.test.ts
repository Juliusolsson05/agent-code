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
      // Waking under Claude filters the Codex-only default out of canonical
      // source metadata. The original undefined provenance must nevertheless
      // let the target Codex session seed that default.
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
      builtInMcpDomains: ['workflows'],
      targetSessionId: 'source-pane',
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('filters explicit source domains before a transcript-less provider switch', async () => {
    const replaceSession = vi.fn().mockResolvedValue('target-pane')
    const ensureSessionLive = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {},
    })
    const refs = {
      stateRef: {
        current: {
          sessions: {
            'source-pane': {
              cwd: '/project',
              kind: 'claude',
              // No providerSessionId: this takes the empty-pane branch.
              builtInMcpDomains: ['workflows'],
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: ['workflows'] },
    } as unknown as WorkspaceRefs

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'codex',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive,
        replaceSession,
      } as unknown as SessionActions,
    })).resolves.toMatchObject({ status: 'switched' })

    expect(ensureSessionLive).not.toHaveBeenCalled()
    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'codex',
      builtInMcpDomains: [],
      targetSessionId: 'source-pane',
    })
  })

  it('does not resurrect an explicit unsupported domain after waking the source', async () => {
    const switchProvider = vi.fn().mockResolvedValue({
      kind: 'switched',
      targetKind: 'codex',
      targetProviderSessionId: 'target-provider-session',
      targetFilePath: '/project/target.jsonl',
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
              providerSessionId: 'source-provider-session',
              builtInMcpDomains: ['workflows'],
            },
          },
        },
      },
      latestRuntimesRef: { current: {} },
      defaultBuiltInMcpDomainsRef: { current: ['workflows'] },
    } as unknown as WorkspaceRefs
    const ensureSessionLive = vi.fn(async () => {
      return { sessionId: 'source-pane', builtInMcpDomains: [] }
    })

    await expect(switchAgentProvider({
      sessionId: 'source-pane',
      targetKind: 'codex',
      refs,
      setRuntimes: vi.fn() as WorkspaceSetRuntimes,
      sessionActions: {
        ensureSessionLive,
        replaceSession,
      } as unknown as SessionActions,
    })).resolves.toMatchObject({ status: 'switched' })

    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'codex',
      resumeSessionId: 'target-provider-session',
      builtInMcpDomains: [],
      targetSessionId: 'source-pane',
    })
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
    })

    expect(switchProvider).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'opencode',
      targetKind: 'claude',
      sourceProviderSessionId: 'ses_precreated_but_empty',
    }))
    expect(replaceSession).toHaveBeenCalledWith('/project', {
      kind: 'claude',
      builtInMcpDomains: ['orchestration'],
      targetSessionId: 'source-pane',
    })
  })
})
