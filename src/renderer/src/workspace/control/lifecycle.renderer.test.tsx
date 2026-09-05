import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useProviderActions } from '@renderer/workspace/hook/actions/provider'
import { makeRefs, sessionActionsWithSpawn } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { Workspace } from '@renderer/workspace/hook'
import { lifecycleControlCapabilities } from './lifecycle'

const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => { cleanup(); useAppStore.setState(original, true); window.api = originalApi })
const context = { requestId: 'original-call', operationId: 'original-call', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'one', generation: 'current' } }
function setup() {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'other' }, focusedSessionId: 'other' }],
    sessions: { source: { kind: 'codex', cwd: '/source', providerSessionId: 'native-source' }, other: { kind: 'claude', cwd: '/other' } },
    detachedSessions: { source: { sessionId: 'source', projectTabId: 'project', projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 1, surface: 'dispatch' } }, buried: [],
  }, workspaceRuntimes: { source: { ...emptyRuntime(), draftInput: 'Human draft' } } })
  const refs = makeRefs(useAppStore.getState().workspaceState)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const replaceSession = vi.fn().mockResolvedValue('replacement')
  const mounted = renderHook(() => useProviderActions(refs, useAppStore.getState().setWorkspaceRuntimes, vi.fn(), sessionActionsWithSpawn(vi.fn(), { replaceSession })))
  const report = vi.fn().mockResolvedValue({ ok: true, value: { recorded: true } })
  window.api = { ...originalApi, controlInvoke: report }
  const caps = lifecycleControlCapabilities(() => ({ ...mounted.result.current, restoreStatus: 'fresh' }) as unknown as Workspace)
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const revision = async () => {
    const result = await invoke('agents.lifecycleRead', { sessionId: 'source' })
    if (!result.ok) throw new Error(JSON.stringify(result))
    return (result.value as { revision: string }).revision
  }
  return { invoke, revision, replaceSession, report, refs, mounted }
}
it('reloads the named detached agent despite another focused pane and records its replacement identity', async () => {
  const { invoke, revision, replaceSession, report } = setup()
  await act(async () => {
    expect(await invoke('agents.reload', { sessionId: 'source', revision: await revision() })).toMatchObject({ ok: true, value: { accepted: true } })
  })
  expect(replaceSession).toHaveBeenCalledExactlyOnceWith('/source', expect.objectContaining({ targetSessionId: 'source', resumeSessionId: 'native-source', kind: 'codex' }))
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: 'operations.finish', input: {
    callId: 'original-call', result: { ok: true, value: { sourceSessionId: 'source', newSessionId: 'replacement', status: 'completed' } },
  } })))
})
it('rejects a changed unsent draft both before admission and after its IPC wait', async () => {
  const { invoke, revision, replaceSession, report } = setup()
  const observed = await revision()
  const edit = () => useAppStore.setState(state => ({ workspaceRuntimes: { ...state.workspaceRuntimes, source: { ...state.workspaceRuntimes.source, draftInput: 'Edited during admission' } } }))
  edit()
  expect(await invoke('agents.reload', { sessionId: 'source', revision: observed })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  expect(report).not.toHaveBeenCalled()
  const fresh = await revision()
  report.mockImplementation(async request => {
    if (request.capabilityId === 'operations.start') useAppStore.setState(state => ({ workspaceRuntimes: { ...state.workspaceRuntimes, source: { ...state.workspaceRuntimes.source, draftInput: 'Another edit' } } }))
    return { ok: true, value: {} }
  })
  await invoke('agents.reload', { sessionId: 'source', revision: fresh })
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: 'operations.finish', input: expect.objectContaining({ result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'stale_cursor' }) }) }) })))
  expect(replaceSession).not.toHaveBeenCalled()
})
it('reports a domain refusal instead of treating a resolved void transaction as completion', async () => {
  const { invoke, revision, replaceSession, report } = setup()
  replaceSession.mockResolvedValue(undefined)
  await invoke('agents.reload', { sessionId: 'source', revision: await revision() })
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: 'operations.finish', input: expect.objectContaining({ result: expect.objectContaining({ ok: false }) }) })))
})

it('keeps draft edits made during native rewind recoverable by undo', async () => {
  const { invoke, revision, replaceSession, report, refs } = setup()
  window.api.rewindToPrompt = vi.fn<typeof window.api.rewindToPrompt>().mockResolvedValue({ provider: 'codex', newProviderSessionId: 'rewound-native', newFilePath: '/recorded/rewound.jsonl', promptText: 'Historical prompt', promptImages: [], promptMode: 'prompt', promptTimestamp: null })
  // The actual replacement contract is independently exercised in
  // sessionReplacementHandoff: this boundary returns its latest carried draft,
  // including edits made after the original lifecycle inspection.
  replaceSession.mockImplementation(async () => {
    useAppStore.getState().setWorkspaceRuntimes(previous => ({ ...previous, replacement: { ...emptyRuntime(), draftInput: 'Edited during replacement' } }))
    refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
    return 'replacement'
  })
  await invoke('agents.rewind', { sessionId: 'source', revision: await revision(), address: { provider: 'codex', sessionId: 'native-source', line: 1 } })
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: 'operations.finish' })))
  expect(useAppStore.getState().workspaceRuntimes.replacement).toMatchObject({ draftInput: 'Historical prompt', pendingRewindUndo: { previousDraftInput: 'Edited during replacement' } })
})
