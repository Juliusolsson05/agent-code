import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { useDraftActions } from '@renderer/workspace/hook/actions/draft'
import { inspectAgentDraft } from '@renderer/workspace/control/drafts'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'
import { templateControlCapabilities } from './control'
const initial = useAppStore.getState(), originalApi = window.api
afterEach(() => { cleanup(); useAppStore.setState(initial, true); window.api = originalApi })
it('inserts dynamic project context into the named agent without following focus and refuses an edit during collection', async () => {
  const sessionId = 'target'
  useAppStore.setState({ workspaceState: { ...initial.workspaceState, activeTabId: 'other-project',
    tabs: [{ id: 'target-project', title: 'Target project', root: { type: 'leaf', sessionId }, focusedSessionId: sessionId },
      { id: 'other-project', title: 'Other project', root: { type: 'leaf', sessionId: 'other' }, focusedSessionId: 'other' }],
    sessions: { target: { kind: 'claude', cwd: '/target', providerSessionId: 'native-target' }, other: { kind: 'codex', cwd: '/other', providerSessionId: 'native-other' } }, detachedSessions: {}, buried: [],
  }, workspaceRuntimes: { target: emptyRuntime(), other: { ...emptyRuntime(), draftInput: 'Other human draft' } } })
  const mounted = renderHook(() => {
    const [, setVersion] = useState(0), setRuntimes = useAppStore.getState().setWorkspaceRuntimes
    return { ...useDraftActions(setRuntimes, (id, patch) => setRuntimes(prev => ({ ...prev, [id]: { ...prev[id], ...patch } })), setVersion), restoreStatus: 'fresh' }
  })
  const resolveTranscriptPaths = vi.fn(async requests => requests.map((request: object) => ({ ...request, transcriptPath: '/recorded/source.jsonl', exists: true })))
  window.api = { ...originalApi, resolveTranscriptPaths }
  const caps = templateControlCapabilities(() => ({ ...mounted.result.current, state: useAppStore.getState().workspaceState,
    activeTab: useAppStore.getState().workspaceState.tabs[1] }) as unknown as Workspace)
  const context = { requestId: 'template', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'one', generation: 'one' } }
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const templateId = 'builtin:active-tab-agent-transcripts'
  const read = await invoke('templates.read', { templateId })
  if (!read.ok) throw new Error(JSON.stringify(read))
  const templateRevision = (read.value as { revision: string }).revision
  const input = { sessionId, tabId: 'target-project', templateId, templateRevision, draftRevision: inspectAgentDraft(sessionId).summary.revision }
  await act(async () => { expect(await invoke('templates.insert', input)).toMatchObject({ ok: true }) })
  expect(resolveTranscriptPaths.mock.calls[0][0]).toMatchObject([{ sessionId: 'target', cwd: '/target' }])
  expect(inspectAgentDraft(sessionId).runtime.draftInput).toContain('Tab: Target project')
  expect(inspectAgentDraft('other').runtime.draftInput).toBe('Other human draft')
  const revision = inspectAgentDraft(sessionId).summary.revision
  resolveTranscriptPaths.mockImplementation(async () => { mounted.result.current.setDraftInput(sessionId, 'Concurrent human edit'); return [] })
  await act(async () => { expect(await invoke('templates.insert', { ...input, draftRevision: revision })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } }) })
  expect(inspectAgentDraft(sessionId).runtime.draftInput).toBe('Concurrent human edit')
})
