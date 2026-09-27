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
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
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
    sessionActionsWithSpawn(vi.fn(), {} as never),
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
