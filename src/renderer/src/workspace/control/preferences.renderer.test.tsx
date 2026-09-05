import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useWorkspaceHelpers } from '@renderer/workspace/hook/helpers'
import { makeRefs } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { Workspace } from '@renderer/workspace/hook'
import { preferenceControlCapabilities } from './preferences'
const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })
const context = { requestId: 'preferences', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'right', generation: 'one' } }
it('uses real follow owners, preserves lanes and other agents, and reports Tail All instead of claiming follow is disabled', async () => {
  useAppStore.setState({ tailAllMode: true, workspaceState: { ...original.workspaceState, sessions: { first: { kind: 'claude', cwd: '/trial' }, second: { kind: 'codex', cwd: '/trial' } } }, workspaceRuntimes: { first: { ...emptyRuntime(), tailMode: true }, second: { ...emptyRuntime(), tailMode: true } } })
  const layout = useAppStore.getState().workspaceState
  const refs = makeRefs(layout)
  const mounted = renderHook(() => useWorkspaceHelpers(useAppStore.getState().workspaceRuntimes, useAppStore.getState().setWorkspaceRuntimes, refs))
  const caps = preferenceControlCapabilities(() => ({ ...mounted.result.current, restoreStatus: 'fresh' }) as unknown as Workspace)
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const before = await invoke('views.preferencesRead', { sessionId: 'first' })
  if (!before.ok) throw new Error('No preferences')
  const revision = (before.value as { revision: string }).revision
  await act(async () => expect(await invoke('views.followSet', { sessionId: 'first', revision, enabled: false })).toMatchObject({ ok: true, value: { autoFollow: false, followEnabled: true, tailAll: true } }))
  expect(useAppStore.getState().workspaceRuntimes.second.tailMode).toBe(true)
  expect(useAppStore.getState().workspaceState).toBe(layout)
  expect(await invoke('views.followSet', { sessionId: 'first', revision, enabled: true })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  expect(await invoke('views.tailAllSet', { expected: true, enabled: false })).toMatchObject({ ok: true, value: { enabled: false } })
  expect(await invoke('views.preferencesRead', { sessionId: 'first' })).toMatchObject({ ok: true, value: { followEnabled: false } })
  expect(await invoke('views.preferencesRead', { sessionId: 'second' })).toMatchObject({ ok: true, value: { followEnabled: true } })
})
