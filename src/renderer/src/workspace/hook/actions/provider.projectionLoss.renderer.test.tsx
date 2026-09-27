import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { makeRefs, sessionActionsWithSpawn } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { DEMOTING_SWITCH_FIDELITY } from '@renderer/workspace/hook/actions/testing/recordedProjectionFidelity'

// #927: the single-pane switch toast names the projector's material loss.
// The transaction itself is mocked: this pins how the pane TELLS the user,
// using a real summary copied from a recorded projection (see
// recordedProjectionFidelity). The projection itself is pinned in main's
// projectionFidelity.system.test.
const { switchAgentProvider } = vi.hoisted(() => ({ switchAgentProvider: vi.fn() }))
vi.mock('@renderer/workspace/hook/actions/providerSwitchCore', async importOriginal => ({
  ...await importOriginal<typeof import('@renderer/workspace/hook/actions/providerSwitchCore')>(),
  switchAgentProvider,
}))

import { useProviderActions } from '@renderer/workspace/hook/actions/provider'
import { LOSSY_SWITCH_TOAST_MS } from '@renderer/workspace/hook/actions/providerSwitchCore'

const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  window.api = originalApi
  switchAgentProvider.mockReset()
})

function setup() {
  useAppStore.setState({
    workspaceState: {
      ...original.workspaceState,
      activeTabId: 'project',
      tabs: [{ id: 'project', title: 'Project' }],
      sessions: { source: { kind: 'claude', cwd: '/source', providerSessionId: 'native-source', projectId: 'project', joinedAt: 0 } },
    },
    workspaceRuntimes: { source: emptyRuntime() },
  })
  const refs = makeRefs(useAppStore.getState().workspaceState)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const showPaneToast = vi.fn()
  const mounted = renderHook(() => useProviderActions(
    refs,
    useAppStore.getState().setWorkspaceRuntimes,
    showPaneToast,
    sessionActionsWithSpawn(vi.fn(), { replaceSession: vi.fn().mockResolvedValue('replacement') } as never),
  ))
  return { mounted, showPaneToast }
}

it('names projection loss on a native (unshrunk) switch, for long enough to read', async () => {
  switchAgentProvider.mockResolvedValue({
    status: 'switched', newSessionId: 'target', targetKind: 'codex', strategy: 'native', shrinkSummary: null,
    projectionFidelity: DEMOTING_SWITCH_FIDELITY,
  })
  const { mounted, showPaneToast } = setup()
  await act(async () => { await mounted.result.current.switchSessionProvider('source', 'codex') })
  expect(showPaneToast).toHaveBeenCalledWith('target', expect.stringMatching(/^Switched to .+ · history: 19 demoted$/), LOSSY_SWITCH_TOAST_MS)
})

it('keeps a lossless switch quiet', async () => {
  switchAgentProvider.mockResolvedValue({
    status: 'switched', newSessionId: 'target', targetKind: 'codex', strategy: 'native', shrinkSummary: null, projectionFidelity: null,
  })
  const { mounted, showPaneToast } = setup()
  await act(async () => { await mounted.result.current.switchSessionProvider('source', 'codex') })
  expect(showPaneToast).toHaveBeenCalledWith('target', expect.not.stringContaining('history'), undefined)
})

// #1384 review a / steering q90: PaneToast clamps to three lines. A recorded
// oversized switch's shrink summary is a long sentence, so the loss goes
// BEFORE it rather than trailing out of sight.
it('puts projection loss before a long shrink summary', async () => {
  switchAgentProvider.mockResolvedValue({
    status: 'switched', newSessionId: 'target', targetKind: 'codex', strategy: 'shrunk',
    shrinkSummary: '1 attachment omitted, 130 oldest entries dropped (17k → 13k chars)',
    projectionFidelity: DEMOTING_SWITCH_FIDELITY,
  })
  const { mounted, showPaneToast } = setup()
  await act(async () => { await mounted.result.current.switchSessionProvider('source', 'codex') })
  const message = showPaneToast.mock.calls.at(-1)![1] as string
  expect(message.indexOf('history: 19 demoted')).toBeGreaterThan(0)
  expect(message.indexOf('history: 19 demoted')).toBeLessThan(message.indexOf('shrunk'))
})

// #1384 review c: a rewind re-projects the kept prefix, and its toast names
// material loss first, like the switch toast.
it('names projection loss in the rewind toast', async () => {
  const { mounted, showPaneToast } = setup()
  window.api = { ...window.api, rewindToPrompt: vi.fn().mockResolvedValue({
    provider: 'claude', newProviderSessionId: 'rewound-native', newFilePath: '/recorded/rewound.jsonl', promptText: 'Earlier', promptImages: [],
    promptAttachments: [], promptMode: 'prompt', promptTimestamp: null, projectionFidelity: DEMOTING_SWITCH_FIDELITY,
  }) } as typeof window.api
  await act(async () => {
    await mounted.result.current.rewindSessionToPrompt('source', { provider: 'claude', sessionId: 'native-source', line: 1, uuid: 'u' } as never)
  })
  expect(showPaneToast).toHaveBeenCalledWith('replacement', 'Rewound to prompt · history: 19 demoted - Undo Rewind available until next submit', 6000)
})
