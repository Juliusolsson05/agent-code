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
    // #1114 changed the CODE this case reports, and nothing else about it.
    // With a resolver wired (production, and this harness), an unresolved path
    // is retried, so the first diagnostic is `db_path_retrying`; the permanent
    // `db_path_unavailable` is emitted only once the ladder is spent, and the
    // package's own suite pins that.
    //
    // What must NOT change is this test's whole point: the pane still fails
    // CLOSED for the entire retry window. `transcriptStatus` is 'error' for
    // every durable diagnostic, transient or not, so Agent Status still says
    // error and `managedTranscriptUnavailableReason` still tells a parent
    // `transcript_unavailable` — which is the property that stops a parent
    // reading an empty conversation as a complete one (R5-F1/R7-F3/R8-F4).
    // Only the LIFETIME banner is withheld, because that one can never be
    // retracted and this state ends.
    name: 'no database path, because `opencode db path` failed',
    database: () => ({ error: 'opencode db path exited with code 1' }),
    channelCode: 'db_path_retrying',
    historyCode: 'open_failed',
  },
]

function recordedStatus(recording: LiveFixture, type: 'busy' | 'idle') {
  const found = recording.sse.find(({ event }) => event.type === 'session.status'
    && (event.properties?.status as { type?: string } | undefined)?.type === type)
  if (!found) throw new Error(`the recording has no ${type} status`)
  return found.event
}

describe('an OpenCode Terminal pane whose server never came up (#881)', () => {
  // Recorded in `port-conflict.json`. Agent Code launches the TUI with a port
  // from a loopback probe that RELEASES it before the TUI binds; another
  // process took it in that window and answered 418. The TUI then neither
  // painted nor exited — it was still running 25 s later, when the recorder
  // killed it.
  //
  // The package detects this and says `live-state { connected: false, reason:
  // 'server-unreachable' }`. Before #881 the adapter forwarded that as a
  // transcript-diagnostic and NOTHING read it: the pane was blank, the process
  // looked alive, and the composer would take text and silently fail, because
  // programmatic delivery goes through the server that never came up.
  it('shows the failure on the pane and keeps showing it', async () => {
    const recording = loadLiveFixture('port-conflict.json')
    const pane = await panes.startRecordedPane(recording, { portConflict: true })

    await waitFor(() => pane.surfaces().transcriptStatus === 'error', 'the unreachable error')
    const message = pane.runtime().transcriptError!
    expect(message).toContain('provider_server_unreachable')
    // What the user can act on: which port, and that the remedy is a reload
    // (this pane cannot be pointed at a different one).
    expect(message).toMatch(/127\.0\.0\.1:\d+/)
    expect(message.toLowerCase()).toContain('reload')

    // The LIFETIME banner, not the transient one. `transcriptError` alone also
    // carries diagnostics that clear themselves; this pane is dead until
    // something real changes, and AgentTerminalLeaf renders this field over
    // the terminal for exactly that case.
    expect(pane.runtime().transcriptChannelError).toBe(message)

    // Agent Status and Dispatch read the same failure — a parent asking about
    // this agent must not be told the transcript is healthy.
    expect(pane.surfaces().agentStatus).toMatchObject({
      Transcript: 'error',
      'Transcript error': expect.stringContaining('provider_server_unreachable'),
    })
    expect(managedTranscriptUnavailableReason(pane.runtime(), pane.meta)).toBe('transcript_unavailable')

    // A history load is the thing that used to write `ready` over a failure
    // (#864 AC8). There is no database read to rescue this pane either.
    //
    // The history source is INSTALLED first, and the call asserted. Without
    // that, `window.api.loadInitialHistory` is undefined, the load throws
    // inside its own catch, and this assertion re-reads a value nothing tried
    // to overwrite — a reviewer proved it by reintroducing the whole AC8
    // regression and watching this case stay green.
    const history = scope.serveHistoryFrom(pane.dbPath!)
    await act(async () => {
      await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
    })
    expect(history.loadInitialHistory).toHaveBeenCalledTimes(1)
    expect(pane.surfaces().transcriptStatus).toBe('error')
    expect(pane.runtime().transcriptChannelError).toBe(message)
  })

  it('clears itself when the server turns out to have been merely late', async () => {
    // `server-unreachable` is a DEADLINE verdict, not a death certificate: the
    // package keeps reconnecting for the life of the instance. A cold start, a
    // restore herd of panes or a sleep/wake straddling the connect deadline
    // all produce a server that answers at 31 s — and the pane is then
    // completely healthy.
    //
    // Before this, the banner was permanent and so was the consequence:
    // `managedTranscriptUnavailableReason` answered `transcript_unavailable`
    // to every parent agent reading that child, over a conversation that was
    // intact.
    const recording = loadLiveFixture('port-conflict.json')
    const pane = await panes.startRecordedPane(recording, { portConflict: true })
    await waitFor(() => pane.surfaces().transcriptStatus === 'error', 'the unreachable error')

    pane.endPortConflict()

    await waitFor(() => pane.runtime().transcriptChannelError === null, 'the banner clearing')
    expect(pane.surfaces().transcriptStatus).not.toBe('error')
    expect(managedTranscriptUnavailableReason(pane.runtime(), pane.meta)).not.toBe('transcript_unavailable')
  })

  it('does not clear a transcript fault that is somebody else\'s', async () => {
    // The control for the clearing above: a live channel connecting says
    // nothing about the DURABLE channel, which is a different reader over a
    // different source. Clearing on any `connected: true` would wipe the
    // #864 AC8 failure the moment the TUI's server came up.
    const recording = loadLiveFixture('plain.json')
    const db = join(scope.dir(), 'refused-for-recovery.db')
    writeFileSync(db, '')
    const pane = await panes.startRecordedPane(recording, { database: db })

    await waitFor(() => pane.surfaces().transcriptStatus === 'error', 'the durable channel error')
    const message = pane.runtime().transcriptError
    // The live channel is up in this pane — `startRecordedPane` waits for it —
    // so the diagnostic that would clear an unreachable banner has already
    // been delivered.
    expect(pane.diagnostics.some(diagnostic => diagnostic.connected === true)).toBe(true)
    expect(pane.runtime().transcriptChannelError).toBe(message)
    expect(pane.surfaces().transcriptStatus).toBe('error')
  })

  it('leaves a TRANSIENT channel diagnostic out of the lifetime banner', async () => {
    // The negative half of the predicate, and a mutation that survived the
    // whole renderer suite without it: making every `jsonl-error` a lifetime
    // banner. `AgentTerminalLeaf` says why that matters — "standing a warning
    // over someone's terminal for those trains them to ignore the banner,
    // which costs exactly the one case it exists for".
    //
    // `sink_failed` is one of the two the predicate deliberately carves out:
    // a delivery hiccup that the next batch recovers from.
    const recording = loadLiveFixture('plain.json')
    const pane = await panes.startRecordedPane(recording)

    act(() => {
      pane.feed.emitJsonlError({
        sessionId: SESSION_ID,
        message: 'OpenCode durable channel (sink_failed): one batch was dropped',
      })
    })

    expect(pane.runtime().transcriptError).toContain('sink_failed')
    expect(pane.runtime().transcriptChannelError).toBeFalsy()
  })

  // #1114. A db-path lookup that is still being retried, and one that already
  // recovered, are both states a pane LEAVES. Nothing in this file ever clears
  // a lifetime banner except the `provider_server_unreachable` gate above, so
  // putting either of these in it marks a pane broken for the life of the app
  // — in this banner, in Agent Status, and in the `transcript_unavailable`
  // every orchestration parent reads through `managedTranscriptUnavailableReason`.
  // That cancels the entire benefit of recovering the channel, which is why
  // the package emits a distinct code for each instead of reusing
  // `db_path_unavailable` (whose #864 AC8 meaning — permanent — the REFUSALS
  // case below still pins).
  it.each([
    ['db_path_retrying', 'Retrying in the background; this pane has no committed transcript until it succeeds.'],
    ['db_path_recovered_late', "anything committed while the database path was unavailable is missing from this pane's transcript"],
  ])('leaves %s out of the lifetime banner', async (code, detail) => {
    const recording = loadLiveFixture('plain.json')
    const pane = await panes.startRecordedPane(recording)

    act(() => {
      pane.feed.emitJsonlError({
        sessionId: SESSION_ID,
        message: `OpenCode durable channel (${code}): ${detail}`,
      })
    })

    expect(pane.runtime().transcriptError).toContain(code)
    expect(pane.runtime().transcriptChannelError).toBeFalsy()
  })

  it('is not cleared by a live-state that is still DOWN', async () => {
    // Only a connection clears this. A `connected: false` diagnostic is the
    // fault restating itself — the package emits one with the verdict, and
    // reconnect attempts can emit more — and treating any live-state as
    // recovery would wipe the banner with the very event that raised it.
    const recording = loadLiveFixture('port-conflict.json')
    const pane = await panes.startRecordedPane(recording, { portConflict: true })
    await waitFor(() => pane.surfaces().transcriptStatus === 'error', 'the unreachable error')
    const message = pane.runtime().transcriptChannelError

    act(() => {
      pane.feed.emitTranscriptDiagnostic({
        sessionId: SESSION_ID,
        diagnostic: { kind: 'opencode-terminal-live-state', connected: false, reason: 'server-unreachable' },
      })
    })

    expect(pane.runtime().transcriptChannelError).toBe(message)
    expect(pane.surfaces().transcriptStatus).toBe('error')
  })

  it('does not report an unreachable server for a pane whose server is fine', async () => {
    // The control. "Always set the banner" would satisfy the case above and
    // put a permanent warning over every healthy OpenCode terminal.
    const recording = loadLiveFixture('plain.json')
    const pane = await panes.startRecordedPane(recording)

    expect(pane.surfaces().transcriptStatus).not.toBe('error')
    expect(pane.runtime().transcriptChannelError).toBeFalsy()
    expect(pane.diagnostics.some(diagnostic => diagnostic.reason === 'server-unreachable')).toBe(false)
  })
})

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
