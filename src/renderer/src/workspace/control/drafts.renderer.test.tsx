import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { useDraftActions } from '@renderer/workspace/hook/actions/draft'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'
import { draftControlCapabilities } from './drafts'

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })
const context = { requestId: 'draft-trial', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'one', generation: 'current' } }

it('reads actual composer edits, protects concurrent text, and uses the existing clear/undo persistence path', async () => {
  const sessionId = crypto.randomUUID()
  useAppStore.setState({ workspaceState: { ...original.workspaceState, sessions: { [sessionId]: { kind: 'claude', cwd: '/trial' } }, buried: [] }, workspaceRuntimes: { [sessionId]: emptyRuntime() } })
  const mounted = renderHook(() => {
    const [version, setVersion] = useState(0)
    const setRuntimes = useAppStore.getState().setWorkspaceRuntimes
    const actions = useDraftActions(setRuntimes, (id, patch) => setRuntimes(prev => ({ ...prev, [id]: { ...prev[id], ...patch } })), setVersion)
    return { ...actions, version, restoreStatus: 'fresh' }
  })
  const capabilities = draftControlCapabilities(() => mounted.result.current as unknown as Workspace)
  const invoke = (id: string, input: unknown) => capabilities.find(item => item.descriptor.id === id)!.execute(input, context)
  const text = 'x'.repeat(255) + '😀' + 'unsent human draft'
  act(() => { mounted.result.current.setDraftInput(sessionId, text) })
  const first = await invoke('agents.draftGet', { sessionId, maxChars: 256 })
  if (!first.ok) throw new Error(JSON.stringify(first))
  const page = first.value as { revision: string; text: string; nextOffset: number }
  expect(page.text).toBe('x'.repeat(255))
  const rest = await invoke('agents.draftGet', { sessionId, revision: page.revision, offset: page.nextOffset })
  expect(rest).toMatchObject({ ok: true, value: { text: '😀unsent human draft', nextOffset: null } })
  act(() => { mounted.result.current.setDraftInput(sessionId, 'new human edit') })
  expect(await invoke('agents.draftSet', { sessionId, revision: page.revision, change: { action: 'replace', text: 'stale overwrite' } })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  const fresh = await invoke('agents.draftGet', { sessionId })
  if (!fresh.ok) throw new Error(JSON.stringify(fresh))
  let cleared!: Awaited<ReturnType<typeof invoke>>
  await act(async () => { cleared = await invoke('agents.draftSet', { sessionId, revision: (fresh.value as { revision: string }).revision, change: { action: 'clear' } }) })
  if (!cleared.ok) throw new Error(JSON.stringify(cleared))
  const clearedRevision = (cleared.value as { revision: string }).revision
  expect(useAppStore.getState().workspaceRuntimes[sessionId].draftInput).toBe('')
  await act(async () => { expect(await invoke('agents.draftSet', { sessionId, revision: clearedRevision, change: { action: 'undo-clear' } })).toMatchObject({ ok: true, value: { changed: true } }) })
  expect(useAppStore.getState().workspaceRuntimes[sessionId].draftInput).toBe('new human edit')
  expect(mounted.result.current.version).toBe(4)
})
