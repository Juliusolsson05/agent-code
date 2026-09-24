import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { usePocketLiveStore } from '../state/pocketLiveStore'
import { useLanePortsStore } from '../state/lanePortsStore'
import { useRecoveryStore } from './recoveryStore'
import { requestServerRestart } from './requestServerRestart'

const initial = useAppStore.getState()
const initialApi = window.api
const failure = { code: '-102', description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/route' }
const wake = vi.fn(async () => ({ sessionId: 'agent' }))
const deliver = vi.fn<typeof window.api.deliverPrompt>()
function getWorkspace(): Workspace {
  const s = useAppStore.getState()
  return { state: s.workspaceState, runtimes: s.workspaceRuntimes, ensureSessionLive: wake } as unknown as Workspace
}
const request = () => requestServerRestart(getWorkspace, 'agent', 'pocket')
const status = () => useRecoveryStore.getState().requests.pocket?.status
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
beforeEach(() => {
  useAppStore.setState({ settings: { ...initial.settings, browserPocketEnabled: true }, workspaceState: {
    tabs: [{ id: 'project', title: 'Project' }], activeTabId: 'project', pinnedSessionIds: [], stage: oneLaneStage('other'),
    sessions: {
      agent: { kind: 'claude', cwd: '/work/project', projectId: 'project', joinedAt: 0, browserPocket: { pocketId: 'pocket', url: failure.url, profile: 'lane', view: 'open' } },
      other: { kind: 'codex', cwd: '/work/other', projectId: 'project', joinedAt: 1 },
    },
  }, workspaceRuntimes: { agent: { ...emptyRuntime(), projectDir: '/work/project/tree', draftInput: 'Unfinished human draft' } } })
  usePocketLiveStore.setState({ live: {} })
  usePocketLiveStore.getState().patch('pocket', { failed: failure })
  useRecoveryStore.setState({ requests: {} })
  useLanePortsStore.setState({ bySession: {} })
  wake.mockReset().mockResolvedValue({ sessionId: 'agent' })
  deliver.mockReset().mockResolvedValue({ ok: true, acceptance: { kind: 'user', acceptedAt: 1 } })
  window.api = { ...initialApi, deliverPrompt: deliver }
})
afterEach(() => { useAppStore.setState(initial, true); window.api = initialApi })

describe('restart request delivery', () => {
  it.each(['user', 'queue', 'transport'] as const)('preserves drafts and reports %s acceptance for the owning agent without discovery or browser MCP', async kind => {
    deliver.mockResolvedValue({ ok: true, acceptance: { kind, acceptedAt: 1 } })
    await request()
    expect(wake).toHaveBeenCalledExactlyOnceWith('agent', 'browser-pocket.restart-request')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toBe('agent')
    expect(deliver.mock.calls[0]?.[1]).toContain('/work/project/tree')
    expect(status()).toEqual({ kind: kind === 'queue' ? 'queued' : 'sent' })
    expect(useAppStore.getState().workspaceRuntimes.agent.draftInput).toBe('Unfinished human draft')
  })

  it('admits only one click while waking and after acceptance, including another failed reload', async () => {
    const pending = deferred<{ sessionId: string }>()
    wake.mockReturnValue(pending.promise)
    const first = request()
    await request()
    expect(wake).toHaveBeenCalledTimes(1)
    pending.resolve({ sessionId: 'agent' })
    await first
    usePocketLiveStore.getState().patch('pocket', { failed: null, loading: true })
    usePocketLiveStore.getState().patch('pocket', { failed: { ...failure }, loading: false })
    await request()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each(['replace', 'worktree', 'provider', 'navigate', 'recover', 'detach', 'disable', 'failure-changed'] as const)('does not deliver when %s happens during wake', async change => {
    const pending = deferred<{ sessionId: string }>()
    wake.mockReturnValue(pending.promise)
    const first = request()
    const s = useAppStore.getState()
    if (change === 'replace') s.setWorkspaceState(prev => ({ ...prev, sessions: { successor: prev.sessions.agent! } }))
    if (change === 'worktree') s.setWorkspaceRuntimes(prev => ({ ...prev, agent: { ...prev.agent!, projectDir: '/elsewhere' } }))
    if (change === 'provider') s.setWorkspaceState(prev => ({ ...prev, sessions: { ...prev.sessions, agent: { ...prev.sessions.agent!, kind: 'codex' } } }))
    if (change === 'navigate') useRecoveryStore.getState().navigating('pocket', 'http://localhost:6000/')
    if (change === 'recover') usePocketLiveStore.getState().patch('pocket', { failed: null })
    if (change === 'detach') s.setWorkspaceState(prev => ({ ...prev, sessions: {} }))
    if (change === 'disable') useAppStore.setState({ settings: { ...s.settings, browserPocketEnabled: false } })
    if (change === 'failure-changed') usePocketLiveStore.getState().patch('pocket', { failed: { ...failure, code: '-200' } })
    pending.resolve({ sessionId: 'agent' })
    await first
    expect(deliver).not.toHaveBeenCalled()
    expect(status()).toBeUndefined()
  })

  it('does not resurrect a forgotten pocket when an invoked delivery resolves late', async () => {
    const pending = deferred<Awaited<ReturnType<typeof window.api.deliverPrompt>>>()
    deliver.mockReturnValue(pending.promise)
    const first = request()
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    useRecoveryStore.getState().clear('pocket')
    pending.resolve({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } })
    await first
    expect(status()).toBeUndefined()
  })

  it('revalidates against the store even before the workspace prop rerenders', async () => {
    const staleWorkspace = getWorkspace()
    const pending = deferred<{ sessionId: string }>()
    wake.mockReturnValue(pending.promise)
    const first = requestServerRestart(() => staleWorkspace, 'agent', 'pocket')
    useAppStore.getState().setWorkspaceState(prev => ({ ...prev, sessions: {} }))
    pending.resolve({ sessionId: 'agent' })
    await first
    expect(deliver).not.toHaveBeenCalled()
    expect(status()).toBeUndefined()
  })

  it('drops a late receipt when the same session moved to a different worktree', async () => {
    const pending = deferred<Awaited<ReturnType<typeof window.api.deliverPrompt>>>()
    deliver.mockReturnValue(pending.promise)
    const first = request()
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    useAppStore.getState().setWorkspaceRuntimes(prev => ({ ...prev, agent: { ...prev.agent!, projectDir: '/different/worktree' } }))
    pending.resolve({ ok: true, acceptance: { kind: 'user', acceptedAt: 1 } })
    await first
    expect(status()).toBeUndefined()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('keeps the send guard when a page reload fails again while provider acceptance is pending', async () => {
    const pending = deferred<Awaited<ReturnType<typeof window.api.deliverPrompt>>>()
    deliver.mockReturnValue(pending.promise)
    const first = request()
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    usePocketLiveStore.getState().patch('pocket', { failed: { ...failure } })
    await request()
    pending.resolve({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } })
    await first
    expect(status()).toEqual({ kind: 'queued' })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each(['retry-same-session', 'retry-after-resolve', 'session-unusable', 'do-not-retry'] as const)('honors no-write disposition %s', async disposition => {
    deliver.mockResolvedValue({ ok: false, stage: 'before-write', code: 'not-ready', message: 'Resolve provider input first', retrySafe: true, disposition, promptWritten: false, enterWritten: false })
    await request()
    expect(status()).toEqual({ kind: 'refused', message: 'Resolve provider input first', retryable: disposition === 'retry-same-session' })
    await request()
    expect(deliver).toHaveBeenCalledTimes(disposition === 'retry-same-session' ? 2 : 1)
  })

  it.each(['unknown-result', 'lost-ipc'] as const)('does not replay %s', async failureKind => {
    if (failureKind === 'lost-ipc') deliver.mockRejectedValue(new Error('IPC disconnected'))
    else deliver.mockResolvedValue({ ok: false, stage: 'after-enter', code: 'acceptance-timeout', message: 'No acknowledgement', retrySafe: false, disposition: 'do-not-retry', promptWritten: true, enterWritten: true })
    await request()
    expect(status()).toEqual({ kind: 'uncertain' })
    await request()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a failed wake leaves a deliberate retry without writing a prompt', async () => {
    wake.mockRejectedValue(new Error('Agent needs login'))
    await request()
    expect(status()).toEqual({ kind: 'refused', retryable: true, message: 'Agent needs login' })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('new failure after successful navigation can request recovery again', async () => {
    await request()
    useRecoveryStore.getState().clear('pocket')
    usePocketLiveStore.getState().patch('pocket', { failed: { ...failure } })
    await request()
    expect(deliver).toHaveBeenCalledTimes(2)
  })
})
