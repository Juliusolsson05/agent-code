import { join } from 'node:path'

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createProjectionDatabase, loadDurableFixture } from 'opencode-terminal-headless/testing'

import type { Entry } from '@shared/types/transcript'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'
import { useWorkspaceAdoption } from '@renderer/workspace/hook/ipc/useWorkspaceAdoption'
import { opencodeTerminalScope, PANE_CWD, SESSION_ID, waitFor } from '@renderer/workspace/hook/ipc/testing/opencodeTerminalScope'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'

// The two restore paths that bring an OpenCode Terminal pane back without a
// rehydrate: adopting a closed window's workspace, and "restart every agent"
// (a dangerous-mode or MCP-domain change). Both now load history for the
// terminal runtime like any agent's; before, they skipped it and the pane
// read empty to everything but the TUI until its next turn. Each is driven
// through its real hook, with history from the real OpenCode history source
// over a recorded session.

const scope = opencodeTerminalScope()

// A census session from OpenCode 1.18.27. Read from the fixture by hand: all
// six messages produce a feed row, and the last one's only text part is this
// (the fixture's sanitized text).
const FIXTURE = 'ses_f96bdb539ffe2Q22Yzk6zhDUYI.json'
const LAST_ANSWER = '<text:3962>'

const messageOrder = (entries: readonly Entry[]): Array<string | undefined> => entries
  .map(entry => (entry as { uuid?: string }).uuid?.split(':result:')[0])
  .filter((id, index, all) => id !== all[index - 1])

function terminalMeta(providerSessionId: string): SessionMeta {
  return { cwd: PANE_CWD, kind: 'opencode', providerRuntime: 'terminal', providerSessionId, providerSessionIdSource: 'jsonl-entry' }
}

function recordedSession() {
  const fixture = loadDurableFixture(FIXTURE)
  const file = join(scope.dir(), 'recorded.db')
  createProjectionDatabase(fixture, file)
  const history = scope.serveHistoryFrom(file)
  // `history.load.end` is the loader's own completion breadcrumb (#283's
  // fingerprint), which is exactly "this load settled, with this outcome".
  const settled: string[] = []
  scope.extendApi({
    reportSessionLifecycle: (report: { name: string; sessionId?: string }) => {
      if (report.name === 'history.load.end' && report.sessionId) settled.push(report.sessionId)
    },
  })
  return { fixture, history, settled }
}

function runtimeStore(initial: Record<SessionId, SessionRuntime>, refs: { latestRuntimesRef: { current: Record<SessionId, SessionRuntime> } }) {
  let runtimes = initial
  refs.latestRuntimesRef.current = runtimes
  return {
    get: () => runtimes,
    set: (next: Record<SessionId, SessionRuntime> | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>)) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    },
  }
}

describe('an OpenCode Terminal pane restored without a rehydrate', () => {
  it("adopting a closed window's terminal pane loads its history once and never leaves it loading", async () => {
    const { fixture, history, settled } = recordedSession()
    let adopt!: (request: { windowId: string; workspace: string }) => void
    scope.extendApi({
      onWorkspaceAdopt: (callback: typeof adopt) => {
        adopt = callback
        return () => {}
      },
      // The backend is alive and already routed here; main reports it ready.
      getBackendSnapshot: vi.fn(async () => ({
        sessionId: SESSION_ID, kind: 'opencode', providerRuntime: 'terminal', cwd: PANE_CWD, lifecycle: 'live', input: { ready: true, revision: 3 },
      })),
      refuseWorkspaceAdoption: vi.fn(async () => undefined),
    })
    const survivor: WorkspaceState = {
      tabs: [{ id: 'own-tab', title: 'own', root: { type: 'leaf', sessionId: 'own-agent' }, focusedSessionId: 'own-agent' }],
      activeTabId: 'own-tab',
      dispatchMode: null,
      sessions: { 'own-agent': { cwd: '/own', kind: 'claude' } },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    }
    const refs = makeRefs(survivor)
    const writer = stateWriter(survivor, refs)
    const runtimes = runtimeStore({ 'own-agent': emptyRuntime() }, refs)
    renderHook(() => useWorkspaceAdoption(refs, writer.setState, runtimes.set, true))

    const closedWindow = {
      tabs: [{ id: 'closed-tab', title: 'closed', root: { type: 'leaf', sessionId: SESSION_ID }, focusedSessionId: SESSION_ID }],
      activeTabId: 'closed-tab',
      dispatchMode: null,
      sessions: { [SESSION_ID]: terminalMeta(fixture.meta.sessionID) },
      detachedSessions: {},
      buried: [],
      tileTabs: null,
    }
    await act(async () => {
      adopt({ windowId: 'closed-window', workspace: JSON.stringify({ workspace: closedWindow }) })
    })
    await waitFor(() => settled.includes(SESSION_ID), "the adopted pane's history load to settle")

    expect(history.loadInitialHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'opencode', providerSessionId: fixture.meta.sessionID }))
    const runtime = runtimes.get()[SESSION_ID]!
    expect(runtime.transcriptStatus).toBe('ready')
    expect(messageOrder(runtime.entries)).toEqual(fixture.messages.map(message => message.id))
    expect(extractLastAssistantText(runtime.entries, 'opencode')).toBe(LAST_ANSWER)
    // The backend snapshot, not the history, says the TUI is up; and the TUI
    // keeps the pane whatever the history holds.
    expect(runtime).toMatchObject({ processStatus: 'started', inputReady: true })
    expect(getEffectiveAgentSurfaceForSession({ kind: 'opencode', providerRuntime: 'terminal', globalMode: 'agent', override: undefined, runtime })).toBe('terminal')
  })

  it('resuming a different saved session inherits the terminal runtime through replaceSession', async () => {
    const { fixture, settled } = recordedSession()
    const spawnSession = vi.fn(async () => ({ sessionId: 'resumed-pane' }))
    const killOwnedSession = vi.fn(async () => true)
    // Spawn also hydrates saved UI ghosts asynchronously. The empty store
    // is a renderer boundary, unrelated to provider history or Resume.
    const ghostRead = vi.fn(async () => [])
    scope.extendApi({ spawnSession, killOwnedSession, ghostRead })
    const state: WorkspaceState = {
      tabs: [{ id: 'project', title: 'project', root: { type: 'leaf', sessionId: SESSION_ID }, focusedSessionId: SESSION_ID }],
      activeTabId: 'project', dispatchMode: null,
      sessions: { [SESSION_ID]: terminalMeta('ses_previous') },
      detachedSessions: {}, buried: [], pinnedSessionIds: [],
    }
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const runtimes = runtimeStore({ [SESSION_ID]: { ...emptyRuntime(), transcriptStatus: 'error', transcriptError: 'old backend stopped', transcriptChannelError: 'old backend stopped' } }, refs)
    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState, runtimes.set, refs,
    ))
    // Resume sends the provider and saved identity, with no runtime override.
    // Only replaceSession knows which surface the old pane was running.
    await act(async () => {
      await result.current.replaceSession(PANE_CWD, { kind: 'opencode', resumeSessionId: fixture.meta.sessionID })
    })
    await waitFor(() => settled.includes('resumed-pane') && ghostRead.mock.calls.length === 1, 'resumed history and ghost bootstrap')
    expect(spawnSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'opencode', providerRuntime: 'terminal', resumeSessionId: fixture.meta.sessionID,
    }))
    expect(writer.getState().sessions['resumed-pane']).toMatchObject({ providerRuntime: 'terminal', providerSessionId: fixture.meta.sessionID })
    expect(runtimes.get()[SESSION_ID]).toBeUndefined()
    expect(runtimes.get()['resumed-pane']!.transcriptStatus).toBe('ready')
    expect(runtimes.get()['resumed-pane']!.transcriptChannelError ?? null).toBeNull()
  })

  it('soft-reloading the view preserves a stopped channel after readable history loads', async () => {
    const { fixture } = recordedSession()
    const state: WorkspaceState = {
      tabs: [{ id: 'project', title: 'project', root: { type: 'leaf', sessionId: SESSION_ID }, focusedSessionId: SESSION_ID }],
      activeTabId: 'project', dispatchMode: null,
      sessions: { [SESSION_ID]: terminalMeta(fixture.meta.sessionID) },
      detachedSessions: {}, buried: [], pinnedSessionIds: [],
    }
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const runtime = { ...emptyRuntime(), transcriptStatus: 'error' as const, transcriptError: 'stopped reader', transcriptChannelError: 'stopped reader' }
    const runtimes = runtimeStore({ [SESSION_ID]: runtime }, refs)
    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState, runtimes.set, refs,
    ))
    await act(async () => { await result.current.softReloadAgentView(SESSION_ID) })
    expect(runtimes.get()[SESSION_ID]).toMatchObject({
      transcriptStatus: 'error', transcriptError: 'stopped reader', transcriptChannelError: 'stopped reader',
    })
    expect(extractLastAssistantText(runtimes.get()[SESSION_ID]!.entries, 'opencode')).toBe(LAST_ANSWER)
  })

  it('restarting every agent respawns a terminal pane on its own runtime and reloads its history', async () => {
    const { fixture, history, settled } = recordedSession()
    const spawnSession = vi.fn(async () => ({ sessionId: 'reloaded-pane' }))
    const killOwnedSession = vi.fn(async () => true)
    scope.extendApi({ spawnSession, killOwnedSession })
    const meta = terminalMeta(fixture.meta.sessionID)
    const state: WorkspaceState = {
      tabs: [{ id: 'project', title: 'project', root: { type: 'leaf', sessionId: SESSION_ID }, focusedSessionId: SESSION_ID }],
      activeTabId: 'project',
      dispatchMode: null,
      sessions: { [SESSION_ID]: meta },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    }
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const runtimes = runtimeStore({ [SESSION_ID]: emptyRuntime() }, refs)
    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState,
      runtimes.set,
      refs,
    ))

    await act(async () => { await result.current.reloadAgentSessions(false) })
    await waitFor(() => settled.includes('reloaded-pane'), "the respawned pane's history load to settle")

    // The old TUI is stopped under its own runtime flavour (a structured
    // OpenCode close must not be able to kill it), and the new one resumes
    // the same OpenCode session on the terminal runtime.
    expect(killOwnedSession).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION_ID, kind: 'opencode', providerRuntime: 'terminal', cwd: PANE_CWD })
    expect(spawnSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'opencode', providerRuntime: 'terminal', cwd: PANE_CWD, resumeSessionId: fixture.meta.sessionID, dangerousMode: false,
    }))
    expect(writer.getState().sessions['reloaded-pane']).toMatchObject({ providerRuntime: 'terminal', providerSessionId: fixture.meta.sessionID })
    expect(writer.getState().tabs[0]!.root).toEqual({ type: 'leaf', sessionId: 'reloaded-pane' })

    expect(history.loadInitialHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'opencode', providerSessionId: fixture.meta.sessionID }))
    const runtime = runtimes.get()['reloaded-pane']!
    expect(runtime.transcriptStatus).toBe('ready')
    expect(messageOrder(runtime.entries)).toEqual(fixture.messages.map(message => message.id))
    expect(extractLastAssistantText(runtime.entries, 'opencode')).toBe(LAST_ANSWER)
    expect(runtimes.get()[SESSION_ID]).toBeUndefined()
  })
})
