import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useSidekickRowActions } from '@renderer/workspace/hook/actions/sidekick'
import type { Workspace } from '@renderer/workspace/hook'
import type { SessionMeta } from '@renderer/workspace/types'
import type { SidekickAttachResult, SidekickIndexView } from '@shared/sidekicks/types'

import { sidekickPlace, useSidekickActions } from './useSidekickActions'
import { useSidekickPersistence } from './useSidekickPersistence'

// The Sidekick feature's orchestration against the REAL workspace row actions
// and app store (#1493). The only stand-ins are main (window.api, returning
// the shapes SidekickService returns) and spawn, which writes the unfiled row
// exactly as session.ts spawn does (cwd, kind, provider id) — the one piece
// of workspace whose own behaviour these tests are not about.

const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  useSidekickIndexStore.setState({ view: null })
  window.api = originalApi
  vi.useRealTimers()
})

const HOME = '/home/recorded'
function view(sidekicks: SidekickIndexView['sidekicks'] = [], revision = 1): SidekickIndexView {
  return { revision, homeDir: HOME, sidekicks }
}

beforeEach(() => {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, sessions: {}, pinnedSessionIds: [] }, workspaceRuntimes: {} })
  useSidekickIndexStore.getState().accept(view())
})

function harness(api: Partial<typeof window.api>, restoreStatus: 'pending' | 'restored' = 'restored') {
  window.api = { ...originalApi, reseedSessionConditions: vi.fn(async () => 0), ...api } as typeof window.api
  const rows = renderHook(() => useSidekickRowActions(useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes)).result
  const spawn = vi.fn(async (cwd: string, opts?: { kind?: string; remoteConnectionId?: string }) => {
    const sessionId = `spawned-${spawn.mock.calls.length}`
    useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { ...prev.sessions, [sessionId]: { cwd, kind: opts?.kind as SessionMeta['kind'], ...(opts?.kind === 'hermes' ? { remoteConnectionId: 'conn-recorded' } : {}) } } }))
    return sessionId
  })
  const ensureSessionLive = vi.fn(async (sessionId: string) => ({ sessionId }))
  const killSession = vi.fn(async () => undefined)
  const workspace = {
    get state() { return useAppStore.getState().workspaceState },
    restoreStatus,
    spawn, ensureSessionLive, killSession,
    get fileSpawnAsSidekick() { return rows.current.fileSpawnAsSidekick },
    get adoptSidekickRow() { return rows.current.adoptSidekickRow },
    get releaseSidekickRow() { return rows.current.releaseSidekickRow },
    get setSidekickPanel() { return rows.current.setSidekickPanel },
  } as unknown as Workspace
  const actions = renderHook(() => useSidekickActions(workspace)).result
  return { actions, spawn, ensureSessionLive, killSession }
}

it('creates a sidekick in the home folder, filed in the same commit, then registered', async () => {
  const registerSidekick = vi.fn(async (request: { id: string; sessionId: string; meta: unknown }) => {
    // The row is already filed when main is asked: autosave never saw it unfiled.
    expect(useAppStore.getState().workspaceState.sessions[request.sessionId]?.sidekickId).toBe(request.id)
    return { ok: true as const }
  })
  const { actions, spawn } = harness({ registerSidekick })
  let id = ''
  await act(async () => { id = await actions.current.createSidekick({ kind: 'hermes' }) })
  expect(spawn).toHaveBeenCalledWith(HOME, { kind: 'hermes', providerRuntime: undefined })
  expect(registerSidekick).toHaveBeenCalledWith({ id, sessionId: 'spawned-1', meta: expect.objectContaining({ sidekickId: id, kind: 'hermes', remoteConnectionId: 'conn-recorded' }) })
  expect(useAppStore.getState().workspaceState.sidekickPanel).toMatchObject({ open: true, sidekickId: id })
})

it('retires the process when main refuses to register it', async () => {
  const { actions, killSession } = harness({ registerSidekick: vi.fn(async () => ({ ok: false as const, reason: 'read-only workspace' })) })
  await act(async () => {
    await expect(actions.current.createSidekick({ kind: 'claude' })).rejects.toThrow('read-only workspace')
  })
  expect(killSession).toHaveBeenCalledWith('spawned-1', 'sidekick.register-failed')
  expect(useAppStore.getState().workspaceState.sessions['spawned-1']).toBeUndefined()
})

it('Open here adopts the record with its draft and wakes it through the ordinary path', async () => {
  const record = { id: '00000000-0000-4000-8000-000000000002', sessionId: 'moved', createdAt: 1, lastActiveAt: 1, draft: 'half a prompt',
    meta: { kind: 'hermes', cwd: HOME, providerSessionId: 'stored', providerSessionIdSource: 'provider-follow', remoteConnectionId: 'conn-recorded', sidekickId: '00000000-0000-4000-8000-000000000002' } }
  const takeSidekick = vi.fn(async (): Promise<SidekickAttachResult> => ({ ok: true, record }))
  const { actions, ensureSessionLive } = harness({ takeSidekick })
  await act(async () => { await actions.current.openHere(record.id) })
  expect(useAppStore.getState().workspaceState.sessions.moved).toMatchObject({ sidekickId: record.id, providerSessionId: 'stored' })
  expect(useAppStore.getState().workspaceRuntimes.moved?.draftInput).toBe('half a prompt')
  expect(ensureSessionLive).toHaveBeenCalledWith('moved', 'sidekick.attach')
  expect(window.api.reseedSessionConditions).toHaveBeenCalledWith(['moved'])
  expect(sidekickPlace(useAppStore.getState().workspaceState.sessions, record.id)).toEqual({ kind: 'here', sessionId: 'moved' })
})

it('a released sidekick leaves this window without a kill, and reads as live elsewhere', async () => {
  const id = '00000000-0000-4000-8000-000000000002'
  useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { held: { kind: 'claude', cwd: HOME, sidekickId: id } } }))
  useAppStore.getState().setWorkspaceRuntimes(() => ({ held: emptyRuntime() }))
  useSidekickIndexStore.getState().accept(view([{ id, sessionId: 'held', kind: 'claude', providerRuntime: null, title: null, agentNameId: null, remoteConnectionId: null, createdAt: 1, lastActiveAt: 1, liveWindowId: 'other-window' }], 2))
  const killOwnedSession = vi.fn(async () => true)
  const { actions } = harness({ killOwnedSession })
  act(() => { actions.current.onReleased({ sidekickId: id, sessionId: 'held' }) })
  expect(useAppStore.getState().workspaceState.sessions.held).toBeUndefined()
  expect(killOwnedSession).not.toHaveBeenCalled()
  expect(sidekickPlace(useAppStore.getState().workspaceState.sessions, id)).toEqual({ kind: 'elsewhere' })
})

it('saves a Hermes /new conversation and a Reload Agent successor to main', async () => {
  vi.useFakeTimers()
  const id = '00000000-0000-4000-8000-000000000002'
  const saveSidekick = vi.fn(async () => ({ ok: true as const }))
  window.api = { ...originalApi, saveSidekick } as typeof window.api
  useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { held: { kind: 'hermes', cwd: HOME, providerSessionId: 'first', sidekickId: id } } }))
  renderHook(() => useSidekickPersistence())
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(saveSidekick).toHaveBeenLastCalledWith(expect.objectContaining({ id, sessionId: 'held', meta: expect.objectContaining({ providerSessionId: 'first' }) }))

  // `/new` rotated the conversation: provider-session-changed rewrote the row.
  useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { held: { ...prev.sessions.held!, providerSessionId: 'second' } } }))
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(saveSidekick).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'held', meta: expect.objectContaining({ providerSessionId: 'second' }) }))

  // Reload Agent: the successor row carries the same sidekickId under a new id.
  useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { successor: { ...prev.sessions.held!, providerSessionId: 'second' } } }))
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(saveSidekick).toHaveBeenLastCalledWith(expect.objectContaining({ id, sessionId: 'successor' }))

  // Nothing changed: no further save.
  const calls = saveSidekick.mock.calls.length
  useAppStore.getState().setWorkspaceRuntimes(prev => ({ ...prev }))
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(saveSidekick.mock.calls.length).toBe(calls)
})

it('retires the process when registering THROWS, not only when main refuses (review round 1, C6)', async () => {
  const { actions, killSession } = harness({ registerSidekick: vi.fn(async () => { throw new Error('store is read-only') }) })
  await act(async () => {
    await expect(actions.current.createSidekick({ kind: 'claude' })).rejects.toThrow('store is read-only')
  })
  expect(killSession).toHaveBeenCalledWith('spawned-1', 'sidekick.register-failed')
  expect(useAppStore.getState().workspaceState.sessions['spawned-1']).toBeUndefined()
})

it('refuses to create while the workspace is restoring: rehydrate would drop the row', async () => {
  const registerSidekick = vi.fn(async () => ({ ok: true as const }))
  const { actions, spawn } = harness({ registerSidekick }, 'pending')
  await act(async () => {
    await expect(actions.current.createSidekick({ kind: 'claude' })).rejects.toThrow('still restoring')
  })
  expect(spawn).not.toHaveBeenCalled()
})

it('a release that arrives before the take reply voids the reply (review round 1)', async () => {
  // Main granted this window the lease, then moved it on (another window's
  // take). Its `released` notice beat the first reply here; installing the
  // row from that late reply would show a sidekick main no longer lets this
  // window type into.
  const id = '00000000-0000-4000-8000-000000000002'
  const record = { id, sessionId: 'moved', createdAt: 1, lastActiveAt: 1, meta: { kind: 'claude', cwd: HOME, sidekickId: id } }
  let reply!: (result: SidekickAttachResult) => void
  const takeSidekick = vi.fn(() => new Promise<SidekickAttachResult>(resolve => { reply = resolve }))
  const { actions, ensureSessionLive } = harness({ takeSidekick })
  let result: SidekickAttachResult | undefined
  await act(async () => {
    const pending = actions.current.openHere(id)
    actions.current.onReleased({ sidekickId: id, sessionId: 'moved' })
    reply({ ok: true, record })
    result = await pending
  })
  expect(result).toEqual({ ok: false, reason: 'owned-elsewhere' })
  expect(useAppStore.getState().workspaceState.sessions.moved).toBeUndefined()
  expect(ensureSessionLive).not.toHaveBeenCalled()
})

it('flushes a pending save on beforeunload instead of losing the last debounce window', async () => {
  vi.useFakeTimers()
  const id = '00000000-0000-4000-8000-000000000002'
  const saveSidekick = vi.fn(async () => ({ ok: true as const }))
  window.api = { ...originalApi, saveSidekick } as typeof window.api
  useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { held: { kind: 'claude', cwd: HOME, sidekickId: id } } }))
  renderHook(() => useSidekickPersistence())
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  const calls = saveSidekick.mock.calls.length
  useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: { held: { ...prev.sessions.held!, title: 'typed just before quit' } } }))
  act(() => { window.dispatchEvent(new Event('beforeunload')) })
  expect(saveSidekick.mock.calls.length).toBe(calls + 1)
  expect(saveSidekick).toHaveBeenLastCalledWith(expect.objectContaining({ meta: expect.objectContaining({ title: 'typed just before quit' }) }))
})
