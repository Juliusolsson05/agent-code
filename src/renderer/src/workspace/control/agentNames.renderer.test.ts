import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'

import { globalControlCapabilities } from '@main/control/globalCapabilities'
import { useAppStore } from '@renderer/app-state/store'
import { claimMissingIdentities } from '@renderer/workspace/agentNames/reconcile'
import { observeWorkspace } from '@renderer/workspace/control'
import type { WorkspaceState } from '@renderer/workspace/types'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

const owners = ['left', 'right'].map(windowId => ({ kind: 'window' as const, windowId, generation: 'current' }))
const context = { requestId: 'search', caller: { kind: 'external' as const, id: 'test' }, owner: { kind: 'main' as const, generation: 'main' } }

function searchOver(workspace: ReturnType<typeof observeWorkspace>) {
  const caps = globalControlCapabilities(async () => [
    ...owners.map(owner => ({ windowId: owner.windowId, owner, workspace })),
    { windowId: 'reloading', owner: null, error: 'window is reloading' },
  ])
  const capability = caps.find(cap => cap.descriptor.id === 'agents.search')!
  return (input: unknown) => capability.execute(input, context)
}

it('publishes enabled names and resolves an exact spoken name across windows', async () => {
  const fixture = JSON.parse(readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'))
  const id: string = fixture.$fixture.observed.targetSessionId
  // Claim identities the same way the running app does, from the recorded
  // workspace, so the test cannot drift from the reconciler's rule.
  const claimed = claimMissingIdentities(fixture.state as WorkspaceState)
  const identity = claimed.sessions[id].agentNameId!

  useAppStore.setState({
    workspaceState: claimed,
    workspaceTileTabs: null,
    workspaceReaderMode: null,
    workspaceSpotlight: null,
    workspaceRuntimes: {},
    workspaceAgentNames: { [identity]: 'Apollo' },
    settings: { ...useAppStore.getState().settings, agentNamesEnabled: true },
  })

  const observed = observeWorkspace(() => ({ restoreStatus: 'complete-restore' }))
  expect(observed.sessions.find(session => session.sessionId === id)?.agentName).toBe('Apollo')
  // Every other agent in the recorded workspace is unnamed, and an unnamed
  // agent must report null rather than an empty string an operator could match.
  expect(observed.sessions.filter(session => session.agentName !== null)).toHaveLength(1)

  const search = searchOver(observed)

  // The same agent is observed by two windows, so an exact name still returns
  // BOTH candidates: name lookup must not quietly resolve the ambiguity that
  // ownership handling exists to surface.
  expect(await search({ name: 'apollo' })).toMatchObject({ ok: true, value: {
    total: 2,
    items: [{ sessionId: id, owner: owners[0] }, { sessionId: id, owner: owners[1] }],
    unavailableWindows: [{ windowId: 'reloading', error: 'window is reloading' }],
  } })
  expect(await search({ name: '  APOLLO  ', windowId: 'right' })).toMatchObject({ ok: true, value: {
    total: 1, items: [{ sessionId: id, owner: owners[1] }],
  } })
  // Exact, never substring: "Apo" is not an address.
  expect(await search({ name: 'Apo' })).toMatchObject({ ok: true, value: { total: 0 } })
  // The free-text query still finds it, which is what makes a partially heard
  // name recoverable without weakening the exact filter.
  expect(await search({ query: 'apoll' })).toMatchObject({ ok: true, value: { total: 2 } })
})

it('hides names and name lookup while the setting is off', async () => {
  const fixture = JSON.parse(readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'))
  const id: string = fixture.$fixture.observed.targetSessionId
  const claimed = claimMissingIdentities(fixture.state as WorkspaceState)

  useAppStore.setState({
    workspaceState: claimed,
    workspaceTileTabs: null,
    workspaceReaderMode: null,
    workspaceSpotlight: null,
    workspaceRuntimes: {},
    workspaceAgentNames: { [claimed.sessions[id].agentNameId!]: 'Apollo' },
    settings: { ...useAppStore.getState().settings, agentNamesEnabled: false },
  })

  const observed = observeWorkspace(() => ({ restoreStatus: 'complete-restore' }))
  expect(observed.sessions.every(session => session.agentName === null)).toBe(true)
  // Disabling the feature must not disable the operator server; search still
  // answers, it simply has no names to match.
  expect(await searchOver(observed)({ name: 'Apollo' })).toMatchObject({ ok: true, value: { total: 0 } })
  expect(await searchOver(observed)({ query: '' })).toMatchObject({ ok: true })
})
