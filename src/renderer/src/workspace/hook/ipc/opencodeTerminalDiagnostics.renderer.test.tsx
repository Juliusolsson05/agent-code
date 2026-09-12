import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The OpenCode Terminal pane harness runs main's real SessionManager and
// forwarder. These are the modules it must not reach for real; each stand-in
// is explained in testing/opencodeTerminalMainStandIns.ts.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('@main/window/windowRegistry.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).windowRegistryStandIn)
vi.mock('@providers/registry.main.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).registryMainStandIn)
vi.mock('@main/workspaceDirectory.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).workspaceDirectoryStandIn)
vi.mock('@main/setup/toolchain.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).toolchainStandIn)
vi.mock('@main/performance/PerformanceService.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).performanceServiceStandIn)
vi.mock('@main/storage/feedDebugLog.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).feedDebugLogStandIn)

import { loadLiveFixture, type LiveFixture } from 'opencode-terminal-headless/testing'

import { managedTranscriptUnavailableReason } from '@renderer/workspace/agentManagementMcp'
import { hydrateTranscriptWithoutWaking } from '@renderer/workspace/hook/actions/hydrateTranscript'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'

import { opencodeTerminalPanes } from './testing/opencodeTerminalPane'
import { opencodeTerminalScope, SESSION_ID, waitFor } from './testing/opencodeTerminalScope'

// #864 AC8: an OpenCode Terminal pane whose durable channel cannot run must
// FAIL CLOSED WITH A DIAGNOSTIC, and stay failed. "Stay" is the part that
// broke: every history load (spawn, reload, restart, the reconciler, an
// Agent Management read) used to turn "cannot read OpenCode's database" into
// "this session has no messages" and write `ready` over the error. A parent
// then read an empty conversation as complete (R5-F1, R7-F3, R8-F4). The
// history source now throws a typed error; these tests hold the whole path
// to it, from the package's channel error to what each surface reports.
//
// Oracles are the error categories the package and the history source
// document (`unsupported_schema`, `db_path_unavailable`, `open_failed`,
// `event_version_unsupported`), not strings read back from the code under test.

const scope = opencodeTerminalScope()
const panes = opencodeTerminalPanes(scope)

type Refusal = {
  name: string
  database: (dir: string) => string | { error: string }
  /** What the adapter's `jsonl-error` names when the pane starts. */
  channelCode: string
  /** What the history source names when a load reads the same database. */
  historyCode: string
}

const REFUSALS: Refusal[] = [
  {
    // A file with none of OpenCode's tables: what an OpenCode older than the
    // event log (or a changed schema) looks like to the reader's gate.
    name: 'a database the reader refuses',
    database: dir => {
      const file = join(dir, 'refused.db')
      writeFileSync(file, '')
      return file
    },
    channelCode: 'unsupported_schema',
    historyCode: 'unsupported_schema',
  },
  {
    name: 'no database path, because `opencode db path` failed',
    database: () => ({ error: 'opencode db path exited with code 1' }),
    channelCode: 'db_path_unavailable',
    historyCode: 'open_failed',
  },
]

function recordedStatus(recording: LiveFixture, type: 'busy' | 'idle') {
  const found = recording.sse.find(({ event }) => event.type === 'session.status'
    && (event.properties?.status as { type?: string } | undefined)?.type === type)
  if (!found) throw new Error(`the recording has no ${type} status`)
  return found.event
}

describe('an OpenCode Terminal pane whose durable channel cannot run', () => {
  it.each(REFUSALS)('fails closed for $name, and no history load turns it ready', async ({ database, channelCode, historyCode }) => {
    const recording = loadLiveFixture('plain.json')
    const db = database(scope.dir())
    const pane = await panes.startRecordedPane(recording, { database: db })

    await waitFor(() => pane.surfaces().transcriptStatus === 'error', 'the durable channel error')
    expect(pane.runtime().transcriptError).toContain(channelCode)
    expect(pane.surfaces().agentStatus).toMatchObject({
      Transcript: 'error',
      'Transcript error': expect.stringContaining(channelCode),
    })
    expect(managedTranscriptUnavailableReason(pane.runtime(), pane.meta)).toBe('transcript_unavailable')

    // Only the durable channel stopped: the TUI's live status still lights
    // and clears the pane, and neither transition clears the diagnostic.
    pane.server.send(recordedStatus(recording, 'busy'))
    await waitFor(() => pane.surfaces().headerLit, 'the recorded busy status')
    pane.server.send(recordedStatus(recording, 'idle'))
    await waitFor(() => pane.surfaces().sessionStatus === 'idle', 'the recorded idle status')
    expect(pane.surfaces().transcriptStatus).toBe('error')

    // A reload's history load reads the same database, and is refused too.
    const history = scope.serveHistoryFrom(db)
    await act(async () => {
      await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
    })
    expect(history.loadInitialHistory).toHaveBeenCalledTimes(1)
    expect(pane.surfaces().transcriptStatus).toBe('error')
    expect(pane.runtime().transcriptError).toContain(historyCode)
    expect(pane.runtime().entries).toEqual([])

    // An Agent Management read re-hydrates any pane that is not `ready`, and
    // must answer "unavailable", never an empty conversation.
    const reason = await act(async () => hydrateTranscriptWithoutWaking({
      sessionId: SESSION_ID,
      refs: pane.refs,
      setRuntimes: pane.setRuntimes,
      read: () => ({ state: pane.state(), runtimes: pane.runtimes() }),
    }))
    expect(reason).toBe('transcript_unavailable')
    expect(history.loadInitialHistory).toHaveBeenCalledTimes(2)
    expect(pane.surfaces().transcriptStatus).toBe('error')
    expect(pane.surfaces().agentStatus['Transcript error']).toContain(historyCode)
  })

  it("keeps the records a failing drain understood and still ends in error, across main's batching", async () => {
    // R4-F1. The durable reader emits what it understood before the event it
    // cannot read, then its error: records first, so nothing understood is
    // lost. Main batches committed records until the next tick but used to
    // send the error at once, so the renderer saw error → records, and the
    // records' `ready` write erased the error of a channel that had stopped.
    const recording = loadLiveFixture('plain.json')
    const pane = await panes.startRecordedPane(recording)
    const lastAnswer = 'The last answer this reader understood'
    const answerId = 'msg_last_understood'

    // One drain sees a completed answer, then an event version this reader
    // was not built for (what a newer OpenCode would write).
    pane.writer!.apply('message.updated.1', { info: { id: answerId, sessionID: recording.sessionID, role: 'assistant', time: { created: 1, completed: 2 } } })
    pane.writer!.apply('message.part.updated.1', { part: { id: 'prt_last_understood', messageID: answerId, sessionID: recording.sessionID, type: 'text', text: lastAnswer } })
    pane.writer!.apply('message.updated.2', { info: { id: 'msg_newer_opencode', sessionID: recording.sessionID, role: 'assistant' } })
    // The bus doorbell for those rows: with the live channel up, the reader
    // drains when OpenCode announces a message, not on a poll.
    pane.server.send({ type: 'message.updated', properties: { sessionID: recording.sessionID, info: { id: answerId, sessionID: recording.sessionID, role: 'assistant' } } })

    await waitFor(() => pane.channels.includes('session:jsonl-error'), 'the durable channel error')
    pane.flushMain()

    const errorAt = pane.channels.indexOf('session:jsonl-error')
    expect(pane.channels.slice(0, errorAt)).toContain('session:jsonl-entries')
    expect(pane.channels.slice(errorAt)).not.toContain('session:jsonl-entries')
    expect(pane.surfaces()).toMatchObject({ transcriptStatus: 'error', copyLastResponse: lastAnswer })
    expect(pane.runtime().transcriptError).toContain('event_version_unsupported')

    // The projection remains readable even though this reader stopped. A
    // snapshot cannot restore the event channel; neither starting nor ending
    // the read may make Agent Status/Dispatch claim the transcript is healthy.
    const diagnostic = pane.runtime().transcriptError
    const history = scope.serveHistoryFrom(pane.dbPath!)
    await act(async () => {
      const reading = loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
      expect(pane.runtime()).toMatchObject({ transcriptStatus: 'error', transcriptError: diagnostic })
      await reading
    })
    expect(history.loadInitialHistory).toHaveBeenCalledTimes(1)
    expect(pane.surfaces()).toMatchObject({
      transcriptStatus: 'error', copyLastResponse: lastAnswer,
      dispatchSubtitle: diagnostic,
      agentStatus: { Transcript: 'error', 'Transcript error': diagnostic },
    })
    const reason = await act(async () => hydrateTranscriptWithoutWaking({
      sessionId: SESSION_ID, refs: pane.refs, setRuntimes: pane.setRuntimes,
      read: () => ({ state: pane.state(), runtimes: pane.runtimes() }),
    }))
    expect(reason).toBe('transcript_unavailable')
    expect(history.loadInitialHistory).toHaveBeenCalledTimes(2)
    expect(pane.runtime()).toMatchObject({ transcriptStatus: 'error', transcriptError: diagnostic })
  })
})
