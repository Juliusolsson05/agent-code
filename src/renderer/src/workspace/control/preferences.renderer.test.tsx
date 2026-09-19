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
  // useWorkspaceHelpers reads runtimes through refs and toggles via the
  // setRuntimes updater, so the harness only needs the setter after the
  // runtime-isolation refactor (dropped the render-time runtimes parameter).
  const mounted = renderHook(() => useWorkspaceHelpers(useAppStore.getState().setWorkspaceRuntimes, refs))
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


it('reports working follow dynamically and invalidates stale preference revisions', async () => {
  useAppStore.setState({ tailAllMode: false, tailWorkingMode: true,
    workspaceState: { ...original.workspaceState, sessions: { first: { kind: 'claude', cwd: '/trial' } } },
    workspaceRuntimes: { first: { ...emptyRuntime(), sessionStatus: 'running' } },
  })
  const caps = preferenceControlCapabilities(() => ({ restoreStatus: 'fresh' }) as Workspace)
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const busy = await invoke('views.preferencesRead', { sessionId: 'first' })
  expect(busy).toMatchObject({ ok: true, value: { autoFollow: false, tailAll: false, tailWorking: true, followEnabled: true } })
  if (!busy.ok) throw new Error('No preferences')
  const revision = (busy.value as { revision: string }).revision
  useAppStore.setState({ workspaceRuntimes: { first: { ...emptyRuntime(), sessionStatus: 'running', streamPhase: 'awaiting-tool',
    conditions: { provider: 'claude', ts: 1, conditions: {
      'claude.permission-prompt': { kind: 'claude.permission-prompt', state: { visible: true }, actions: [] },
    } },
  } } })
  expect(await invoke('views.preferencesRead', { sessionId: 'first' })).toMatchObject({ ok: true, value: { tailWorking: true, followEnabled: false } })
  expect(await invoke('views.followSet', { sessionId: 'first', revision, enabled: false })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  useAppStore.setState({ workspaceRuntimes: { first: emptyRuntime() } })
  expect(await invoke('views.preferencesRead', { sessionId: 'first' })).toMatchObject({ ok: true, value: { tailWorking: true, followEnabled: false } })
  expect(await invoke('views.followSet', { sessionId: 'first', revision, enabled: false })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  expect(await invoke('views.tailAllSet', { expected: false, enabled: true })).toMatchObject({ ok: true })
  expect(await invoke('views.preferencesRead', { sessionId: 'first' })).toMatchObject({ ok: true, value: { tailAll: true, tailWorking: false, followEnabled: true } })
})
