import { useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import { makeRefs } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { Workspace } from '@renderer/workspace/hook'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import { layoutControlCapabilities } from './layout'

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })
const context = { requestId: 'layout-trial', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'one', generation: 'current' } }

it('preserves recorded workspace identities through row edits and refuses a stale positional action', async () => {
  // This is the persisted multi-project workspace already used by navigation
  // tests. All mutations below run the real workspace hooks against Zustand;
  // no alternative grid implementation or imagined lane normalizer is supplied.
  useAppStore.setState({ workspaceState: loadRecordedDispatchWorkspace().state })
  const mounted = renderHook(() => {
    const state = useAppStore(store => store.workspaceState)
    const refs = useRef(makeRefs(state)).current
    refs.stateRef.current = state; refs.latestStateRef.current = state
    const store = useAppStore.getState()
    const dispatch = useDispatchActions(store.setWorkspaceState, store.setWorkspaceRuntimes, refs, vi.fn(), () => {})
    return { ...dispatch, restoreStatus: 'fresh' }
  })
  const capabilities = layoutControlCapabilities(() => mounted.result.current as unknown as Workspace)
  const invoke = (id: string, input: unknown) => capabilities.find(item => item.descriptor.id === id)!.execute(input, context)
  const readRevision = async () => {
    const result = await invoke('layout.read', {})
    if (!result.ok) throw new Error(JSON.stringify(result))
    return (result.value as { revision: string }).revision
  }
  const configure = async (change: unknown) => {
    const revision = await readRevision()
    await act(async () => { expect(await invoke('dispatch.configure', { revision, change })).toMatchObject({ ok: true }) })
  }
  const originalSessions = Object.keys(useAppStore.getState().workspaceState.sessions)
  await configure({ action: 'grid', rows: [{ sourceRow: 0, length: 5 }, { sourceRow: null, length: 2 }] })
  await configure({ action: 'row-projects', rowIndex: 1, tabIds: ['tab-2'] })
  const stale = await readRevision()
  await configure({ action: 'grid', rows: [{ sourceRow: 1, length: 2 }] })
  const grid = useAppStore.getState().workspaceState.stage
  expect(grid.rows).toMatchObject([{ length: 2, projectTabIds: ['tab-2'] }])
  expect(grid.lanes).toEqual([{}, {}])
  expect(Object.keys(useAppStore.getState().workspaceState.sessions)).toEqual(originalSessions)
  expect(await invoke('dispatch.configure', { revision: stale, change: { action: 'lane-focus', laneIndex: 1 } })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })

  // layout.adjust (rotate an explicit project's tree without activating it)
  // was asserted here until #992 deleted the tile tree and that capability.
  expect(capabilities.some(item => item.descriptor.id === 'layout.adjust')).toBe(false)
})

it('reports the focused lane s agent as the one focus truth through lane replacement and removal (#798)', async () => {
  useAppStore.setState({ workspaceState: loadRecordedDispatchWorkspace().state, workspaceReaderMode: null, workspaceSpotlight: null })
  const mounted = renderHook(() => {
    const state = useAppStore(store => store.workspaceState)
    const refs = useRef(makeRefs(state)).current
    refs.stateRef.current = state; refs.latestStateRef.current = state
    const store = useAppStore.getState()
    return { ...useDispatchActions(store.setWorkspaceState, store.setWorkspaceRuntimes, refs, vi.fn(), () => {}), restoreStatus: 'fresh' }
  })
  const caps = layoutControlCapabilities(() => mounted.result.current as unknown as Workspace)
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const read = async () => {
    const result = await invoke('layout.read', {})
    if (!result.ok) throw new Error(JSON.stringify(result))
    return result.value as unknown as { revision: string; effectiveFocusedSessionId: string | null; dispatch: { focusedSessionId: string | null } }
  }
  const configure = async (change: unknown) => { const revision = (await read()).revision; await act(async () => { expect(await invoke('dispatch.configure', { revision, change })).toMatchObject({ ok: true }) }) }
  await configure({ action: 'grid', rows: [{ sourceRow: 0, length: 4 }] })
  await configure({ action: 'lane-select', laneIndex: 1, sessionId: 'session-23' })
  await configure({ action: 'lane-focus', laneIndex: 1 })
  expect((await read()).effectiveFocusedSessionId).toBe('session-23')
  await configure({ action: 'lane-select', laneIndex: 1, sessionId: 'session-1' })
  const replaced = await read()
  expect(replaced.dispatch.focusedSessionId).toBe(replaced.effectiveFocusedSessionId)
  expect(replaced.effectiveFocusedSessionId).toBe('session-1')
  await configure({ action: 'grid', rows: [{ sourceRow: 0, length: 1 }] })
  const removed = await read()
  expect(removed.dispatch.focusedSessionId).toBe(removed.effectiveFocusedSessionId)
  expect(removed.effectiveFocusedSessionId).not.toBe('session-23')
  // The published envelope no longer carries the two fields whose subjects
  // #992 deleted: a remembered classic selection and a layout-wide scope.
  expect(removed.dispatch).not.toHaveProperty('classicFocusedSessionId')
  expect(removed.dispatch).not.toHaveProperty('scope')
})

it('refuses the retired enter / exit / scope actions instead of succeeding silently', async () => {
  // An agent written against the two-mode layout will still send these. A
  // no-op success would tell it the layout changed when nothing did, so the
  // input schema rejects them outright (#992).
  useAppStore.setState({ workspaceState: loadRecordedDispatchWorkspace().state, workspaceReaderMode: null, workspaceSpotlight: null })
  const mounted = renderHook(() => {
    const state = useAppStore(store => store.workspaceState)
    const refs = useRef(makeRefs(state)).current
    refs.stateRef.current = state; refs.latestStateRef.current = state
    const store = useAppStore.getState()
    return { ...useDispatchActions(store.setWorkspaceState, store.setWorkspaceRuntimes, refs, vi.fn(), () => {}), restoreStatus: 'fresh' }
  })
  const caps = layoutControlCapabilities(() => mounted.result.current as unknown as Workspace)
  const invoke = (id: string, input: unknown) => caps.find(cap => cap.descriptor.id === id)!.execute(input, context)
  const read = await invoke('layout.read', {})
  if (!read.ok) throw new Error(JSON.stringify(read))
  const revision = (read.value as { revision: string }).revision
  const before = useAppStore.getState().workspaceState
  for (const change of [{ action: 'enter', scope: 'global' }, { action: 'exit' }, { action: 'scope', scope: 'project' }]) {
    expect(await invoke('dispatch.configure', { revision, change })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(useAppStore.getState().workspaceState).toBe(before)
})
