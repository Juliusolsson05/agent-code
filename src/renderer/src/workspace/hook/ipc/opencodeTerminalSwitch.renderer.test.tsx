import { act } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

// Only platform/factory seams are replaced; events cross the real package,
// adapter, SessionManager, forwarder/coalescers, and renderer subscriptions.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('@main/window/windowRegistry.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).windowRegistryStandIn)
vi.mock('@providers/registry.main.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).registryMainStandIn)
vi.mock('@main/workspaceDirectory.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).workspaceDirectoryStandIn)
vi.mock('@main/setup/toolchain.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).toolchainStandIn)
vi.mock('@main/performance/PerformanceService.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).performanceServiceStandIn)
vi.mock('@main/storage/feedDebugLog.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).feedDebugLogStandIn)

import { loadLiveFixture, sessionRowFor } from 'opencode-terminal-headless/testing'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import { opencodeTerminalPanes } from './testing/opencodeTerminalPane'
import { opencodeTerminalScope, SESSION_ID, waitFor } from './testing/opencodeTerminalScope'

const scope = opencodeTerminalScope()
const panes = opencodeTerminalPanes(scope)

it('shows TUI navigation in Agent Status and Dispatch while retaining the bound session and live channel', async () => {
  const recording = loadLiveFixture('plain.json')
  const pane = await panes.startRecordedPane(recording)
  const from = recording.sessionID
  const to = 'ses_other_root'
  pane.writer!.addSession({ ...sessionRowFor(to), id: to })
  pane.server.send({ type: 'message.updated', properties: { info: { id: 'msg_other_user', role: 'user', sessionID: to } } })
  await waitFor(() => pane.runtime().transcriptError?.includes('provider_session_switched') === true, 'session switch diagnostic')
  const expected = `OpenCode switched to session ${to} inside the TUI. This pane still follows ${from}. Resume ${to} from the Resume picker to follow it. (provider_session_switched)`
  expect(pane.channels.filter(channel => channel === 'session:jsonl-error')).toHaveLength(1)
  expect(pane.surfaces()).toMatchObject({
    transcriptStatus: 'error', dispatchSubtitle: expected,
    agentStatus: { Transcript: 'error', 'Transcript error': expected, 'Provider session': `following · ${from.slice(0, 12)} · TUI switched session` },
  })
  expect(pane.state().sessions[SESSION_ID]!.providerSessionId).toBe(from)
  expect(pane.runtime().entries).toEqual([])

  // A completed assistant for the bound session is still useful to readers,
  // but cannot certify which session the TUI displays. Test both a subsequent
  // live record and a successful history load: both used to clear errors.
  pane.server.send({ type: 'session.status', properties: { sessionID: from, status: { type: 'busy' } } })
  await waitFor(() => pane.surfaces().headerLit, 'bound session still busy')
  pane.writer!.apply('message.updated.1', { info: { id: 'msg_bound_answer', sessionID: from, role: 'assistant', time: { created: 10, completed: 20 } } })
  pane.writer!.apply('message.part.updated.1', { part: { id: 'prt_bound_answer', sessionID: from, messageID: 'msg_bound_answer', type: 'text', text: 'Still observing the bound session' } })
  pane.server.send({ type: 'message.updated', properties: { info: { id: 'msg_bound_answer', sessionID: from, role: 'assistant' } } })
  await waitFor(() => pane.surfaces().copyLastResponse === 'Still observing the bound session', 'bound transcript record')
  expect(pane.runtime()).toMatchObject({ transcriptStatus: 'error', transcriptError: expected })
  scope.serveHistoryFrom(pane.dbPath!)
  await act(async () => { await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes }) })
  expect(pane.surfaces().dispatchSubtitle).toBe(expected)
  pane.server.send({ type: 'session.idle', properties: { sessionID: from } })
  await waitFor(() => pane.surfaces().sessionStatus === 'idle', 'bound session still settles')
  expect(pane.runtime().transcriptError).toBe(expected)
  expect(pane.state().sessions[SESSION_ID]!.providerSessionId).toBe(from)

  // On repeated navigation, `from` in the package event is the previous TUI
  // screen. The user must still be told which transcript this pane follows.
  pane.writer!.addSession({ ...sessionRowFor('ses_third_root'), id: 'ses_third_root' })
  pane.server.send({ type: 'message.updated', properties: { info: { id: 'msg_third_user', role: 'user', sessionID: 'ses_third_root' } } })
  await waitFor(() => pane.runtime().transcriptError?.includes('Resume ses_third_root') === true, 'second switch')
  expect(pane.runtime().transcriptError).toContain(`This pane still follows ${from}.`)
  expect(pane.state().sessions[SESSION_ID]!.providerSessionId).toBe(from)
})

it('does not mistake a task child prompt or activity for TUI navigation', async () => {
  const recording = loadLiveFixture('permission-once.json')
  const pane = await panes.startRecordedPane(recording)
  const child = 'ses_task_child'
  pane.writer!.addSession({ ...sessionRowFor(child), id: child, parent_id: recording.sessionID })
  pane.server.send({ type: 'message.updated', properties: { info: { id: 'msg_child_user', role: 'user', sessionID: child } } })
  pane.server.send({ type: 'session.status', properties: { sessionID: child, status: { type: 'busy' } } })
  const asked = recording.sse.find(({ event }) => event.type === 'permission.asked')!.event
  pane.server.send({ ...asked, properties: { ...asked.properties, sessionID: child } })
  // The visible child condition is an ordering fence: its earlier prompt and
  // status have traversed the same stream, with parentage read from SQLite.
  await waitFor(() => Boolean(pane.runtime().conditions?.conditions['opencode.permission']), 'child permission')
  expect(pane.runtime().transcriptError).toBeNull()
  expect(pane.channels).not.toContain('session:jsonl-error')
  expect(pane.surfaces().sessionStatus).toBe('idle')
  expect(pane.surfaces().headerLit).toBe(false)
  expect(pane.state().sessions[SESSION_ID]!.providerSessionId).toBe(recording.sessionID)
})
