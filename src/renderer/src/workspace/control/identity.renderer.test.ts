import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { observeWorkspace } from '@renderer/workspace/control'
import { globalControlCapabilities } from '@main/control/globalCapabilities'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))
it('resolves the recorded visible Dispatch label instead of its different project-local coordinate, retaining cross-window ambiguity', async () => {
  const fixture = JSON.parse(readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'))
  const bundle = JSON.parse(readFileSync('testing/fixtures/rendering-bundles/2026-05-20T19-11-51-193-d4a44a16.json', 'utf8'))
  const id = fixture.$fixture.observed.targetSessionId
  useAppStore.setState({ workspaceState: fixture.state as WorkspaceState, workspaceTileTabs: null, workspaceReaderMode: null, workspaceSpotlight: null,
    workspaceRuntimes: { [id]: { ...emptyRuntime(), entries: bundle.input.entries } } })
  const observed = observeWorkspace(() => ({ restoreStatus: 'fresh' }))
  const target = observed.sessions.find(session => session.sessionId === id)!
  const visible = buildVisibleDispatchRows(fixture.state).find(row => row.sessionId === id)!
  expect(target.displayLabel).toBe(fixture.$fixture.observed.targetVisibleLabel)
  expect(target.displayLabel).not.toBe(fixture.$fixture.observed.targetLocalLabel)
  expect(target.displayedTitle).toBe(dispatchRowTitle(visible, bundle.input.entries))
  const owners = ['left', 'right'].map(windowId => ({ kind: 'window' as const, windowId, generation: 'current' }))
  const caps = globalControlCapabilities(async () => owners.map(owner => ({ windowId: owner.windowId, owner, workspace: observed })))
  const search = (input: unknown) => caps.find(cap => cap.descriptor.id === 'agents.search')!.execute(input, { requestId: 'search', caller: { kind: 'external', id: 'test' }, owner: { kind: 'main', generation: 'main' } })
  expect(await search({ label: target.displayLabel })).toMatchObject({ ok: true, value: { total: 2, items: [
    { sessionId: id, owner: owners[0] }, { sessionId: id, owner: owners[1] },
  ] } })
  expect(await search({ label: target.displayLabel, windowId: 'right' })).toMatchObject({ ok: true, value: { total: 1, items: [{ sessionId: id, owner: owners[1] }] } })
})
