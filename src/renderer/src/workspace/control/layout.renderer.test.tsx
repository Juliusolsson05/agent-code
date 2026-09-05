import { useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
const fixture = JSON.parse(readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'))
import { useAppStore } from '@renderer/app-state/store'
import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import { useResizeActions } from '@renderer/workspace/hook/actions/resize'
import { makeRefs } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/hook'
import { layoutControlCapabilities } from './layout'

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })
const context = { requestId: 'layout-trial', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'window' as const, windowId: 'one', generation: 'current' } }

it('preserves recorded workspace identities through row edits and refuses a stale positional action', async () => {
  // This is the persisted multi-project workspace already used by navigation
  // tests. All mutations below run the real workspace hooks against Zustand;
  // no alternative grid implementation or imagined lane normalizer is supplied.
  useAppStore.setState({ workspaceState: structuredClone(fixture.state) as unknown as WorkspaceState })
  const mounted = renderHook(() => {
    const state = useAppStore(store => store.workspaceState)
    const refs = useRef(makeRefs(state)).current
    refs.stateRef.current = state; refs.latestStateRef.current = state
    const store = useAppStore.getState()
    const dispatch = useDispatchActions(state, store.setWorkspaceState, store.setWorkspaceTileTabs, () => {}, refs, vi.fn(), () => {})
    const resize = useResizeActions(store.setWorkspaceState, store.setWorkspaceTileTabs)
    return { ...dispatch, ...resize, restoreStatus: 'fresh' }
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
  const grid = useAppStore.getState().workspaceState.dispatchMode!.tiled!
  expect(grid.rows).toMatchObject([{ length: 2, projectTabIds: ['tab-2'] }])
  expect(grid.lanes).toEqual([{}, {}])
  expect(Object.keys(useAppStore.getState().workspaceState.sessions)).toEqual(originalSessions)
  expect(await invoke('dispatch.configure', { revision: stale, change: { action: 'lane-focus', laneIndex: 1 } })).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })

  act(() => { useAppStore.getState().setWorkspaceState(state => ({ ...state, activeTabId: 'tab-1' })) })
  const revision = await readRevision()
  await act(async () => { expect(await invoke('layout.adjust', { tabId: 'tab-4', revision, change: { action: 'rotate' } })).toMatchObject({ ok: true }) })
  expect(useAppStore.getState().workspaceState.activeTabId).toBe('tab-1')
  expect(useAppStore.getState().workspaceState.tabs.find(tab => tab.id === 'tab-4')!.root).toMatchObject({ direction: 'horizontal' })
})
