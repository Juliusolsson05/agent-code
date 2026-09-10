import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useProviderActions } from '@renderer/workspace/hook/actions/provider'
import { makeRefs, sessionActionsWithSpawn } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'

const original = useAppStore.getState()
const originalApi = window.api

afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  window.api = originalApi
})

function setup(options?: {
  providerSessionId?: string | null
  processActive?: boolean
}) {
  const providerSessionId = options?.providerSessionId === undefined
    ? 'native-source'
    : options.providerSessionId ?? undefined
  useAppStore.setState({
    workspaceState: {
      ...original.workspaceState,
      activeTabId: 'project',
      tabs: [{
        id: 'project',
        title: 'Project',
        root: { type: 'leaf', sessionId: 'source' },
        focusedSessionId: 'source',
      }],
      sessions: {
        source: {
          kind: 'codex',
          cwd: '/source',
          providerSessionId,
          builtInMcpDomains: ['orchestration'],
        },
      },
      buried: [],
    },
    workspaceRuntimes: {
      source: {
        ...emptyRuntime(),
        draftInput: 'Keep this draft',
        processActive: options?.processActive ?? false,
      },
    },
  })
  const refs = makeRefs(useAppStore.getState().workspaceState)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const replaceSession = vi.fn().mockImplementation(async () => {
    useAppStore.getState().setWorkspaceRuntimes(previous => ({
      ...previous,
      replacement: { ...emptyRuntime(), draftInput: previous.source?.draftInput ?? '' },
    }))
    refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
    return 'replacement'
  })
  const showPaneToast = vi.fn()
  const splitFocused = vi.fn()
  const stripCodexCyberPolicy = vi.fn().mockResolvedValue({
    provider: 'codex',
    newProviderSessionId: 'stripped-native',
    newFilePath: '/recorded/stripped.jsonl',
  })
  window.api = { ...originalApi, stripCodexCyberPolicy }
  const mounted = renderHook(() => useProviderActions(
    refs,
    useAppStore.getState().setWorkspaceRuntimes,
    showPaneToast,
    sessionActionsWithSpawn(vi.fn(), { replaceSession, splitFocused } as never),
  ))
  return { mounted, replaceSession, splitFocused, showPaneToast, stripCodexCyberPolicy, refs }
}

it('re-homes the focused pane onto the stripped Codex session and records undo', async () => {
  const { mounted, replaceSession, splitFocused, stripCodexCyberPolicy } = setup()

  await act(async () => {
    await mounted.result.current.removeCodexCyberPolicyBlock('source')
  })

  expect(stripCodexCyberPolicy).toHaveBeenCalledExactlyOnceWith({
    provider: 'codex',
    sourceProviderSessionId: 'native-source',
    cwd: '/source',
  })
  expect(replaceSession).toHaveBeenCalledExactlyOnceWith('/source', {
    kind: 'codex',
    resumeSessionId: 'stripped-native',
    builtInMcpDomains: ['orchestration'],
    targetSessionId: 'source',
  })
  expect(splitFocused).not.toHaveBeenCalled()
  expect(useAppStore.getState().workspaceRuntimes.replacement).toMatchObject({
    draftInput: 'Keep this draft',
    pendingRewindUndo: {
      provider: 'codex',
      previousProviderSessionId: 'native-source',
      rewoundProviderSessionId: 'stripped-native',
      previousDraftInput: 'Keep this draft',
    },
  })
})

it('skips IPC while a Codex turn is still running', async () => {
  const { mounted, replaceSession, stripCodexCyberPolicy, showPaneToast } = setup({ processActive: true })

  await act(async () => {
    await expect(mounted.result.current.removeCodexCyberPolicyBlock('source')).resolves.toMatchObject({
      status: 'skipped',
    })
  })

  expect(stripCodexCyberPolicy).not.toHaveBeenCalled()
  expect(replaceSession).not.toHaveBeenCalled()
  expect(showPaneToast).toHaveBeenCalledWith(
    'source',
    'Wait for the current turn to finish before removing the cybersecurity block',
  )
})

it('skips IPC when the pane has no durable provider session id', async () => {
  const { mounted, replaceSession, stripCodexCyberPolicy, showPaneToast } = setup({
    providerSessionId: null,
  })

  await act(async () => {
    await expect(mounted.result.current.removeCodexCyberPolicyBlock('source')).resolves.toMatchObject({
      status: 'skipped',
    })
  })

  expect(stripCodexCyberPolicy).not.toHaveBeenCalled()
  expect(replaceSession).not.toHaveBeenCalled()
  expect(showPaneToast).toHaveBeenCalledWith('source', 'Provider session id is not ready yet')
})

it('toasts a missing cyber block and does not replace the pane', async () => {
  const { mounted, replaceSession, stripCodexCyberPolicy, showPaneToast } = setup()
  stripCodexCyberPolicy.mockRejectedValueOnce(new Error('No cybersecurity block at the end of this Codex session.'))

  await act(async () => {
    await expect(mounted.result.current.removeCodexCyberPolicyBlock('source')).resolves.toMatchObject({
      status: 'failed',
    })
  })

  expect(replaceSession).not.toHaveBeenCalled()
  expect(showPaneToast).toHaveBeenCalledWith(
    'source',
    'No cybersecurity block at the end of this Codex session.',
  )
})
