import { afterEach, describe, expect, it, vi } from 'vitest'

// The pane harness runs main's real SessionManager and forwarder. These are
// the modules it must not reach for real; each stand-in is explained in
// testing/opencodeTerminalMainStandIns.ts. The provider registry is REAL for
// Pi (prompt delivery, history, transcript identity), and only its terminal
// factory is swapped, so the adapter gets a fake PTY and the replay launch.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('@main/window/windowRegistry.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).windowRegistryStandIn)
vi.mock('@main/workspaceDirectory.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).workspaceDirectoryStandIn)
vi.mock('@main/setup/toolchain.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).toolchainStandIn)
vi.mock('@main/performance/PerformanceService.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).performanceServiceStandIn)
vi.mock('@main/storage/feedDebugLog.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).feedDebugLogStandIn)
vi.mock('@providers/registry.main.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/registry.main.js')>()
  const { mainStandIns } = await import('./testing/opencodeTerminalMainStandIns')
  return {
    ...actual,
    getMainProvider: (kind: Parameters<typeof actual.getMainProvider>[0]) => kind !== 'pi' ? actual.getMainProvider(kind) : {
      ...actual.getMainProvider('pi'),
      createTerminalSession: (options: Parameters<NonNullable<ReturnType<typeof actual.getMainProvider>['createTerminalSession']>>[0]) => {
        if (!mainStandIns.createTerminalSession) throw new Error('no Pi factory installed')
        return mainStandIns.createTerminalSession(options)
      },
    },
  }
})

import { loadLiveFixture, referenceActiveBranch, type LiveFixture, type RecordedRow } from 'pi-terminal-headless/testing/index'

import { entryTextContent } from '@renderer/session-runtime/entries'
import { clearLiveEntryWindowSession, markUuidsTrimmed } from '@renderer/session-runtime/liveEntryWindow'
import { managedTranscriptUnavailableReason } from '@renderer/workspace/agentManagementMcp'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'

import { startRecordedPiPane, waitFor, type PiPane } from './testing/piTerminalPane'

// What a user and an orchestrating parent see of a Pi pane while a recorded
// pi session plays through the real stack (see testing/piTerminalPane.tsx for
// exactly what is real). Oracles are the recordings: the prompts pi recorded,
// the answer it committed, the session ids it reported. Nothing is read back
// through the code under test.

const cleanups: Array<() => unknown> = []
const onCleanup = (cleanup: () => unknown) => { cleanups.push(cleanup) }
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw failures[0]
})

const textOf = (row: RecordedRow) => ((row.message as { content: Array<{ type: string; text?: string }> }).content).filter(b => b.type === 'text').map(b => b.text).join('')
const branchOf = (fixture: LiveFixture, index = 0) => referenceActiveBranch(Object.entries(fixture.files).sort(([a], [b]) => a.localeCompare(b))[index]![1])
const typedPrompts = (rows: RecordedRow[]) => rows.filter(row => row.type === 'message' && (row.message as { role: string }).role === 'user').map(textOf)
const lastAnswer = (rows: RecordedRow[]) => textOf([...rows].reverse().find(row => row.type === 'message' && (row.message as { role: string; stopReason?: string }).role === 'assistant' && (row.message as { stopReason?: string }).stopReason === 'stop')!)
const userEntries = (pane: PiPane) => pane.runtime().entries.filter(entry => entry.type === 'user' && entryTextContent(entry)).map(entry => entryTextContent(entry))

async function played(pane: PiPane, expectAnswer: string): Promise<void> {
  await pane.play()
  await waitFor(() => pane.surfaces().sessionStatus === 'idle' && pane.surfaces().copyLastResponse === expectAnswer, 'the recorded turn to end with its answer')
  pane.flushMain()
}

describe('a Pi pane driven by a recorded pi session, end to end', () => {
  it('a pane created kind-only runs pi’s TUI, lights every surface during the run, and ends idle, completed, with the answer', async () => {
    const fixture = loadLiveFixture('tool')
    const branch = branchOf(fixture)
    const pane = await startRecordedPiPane(fixture, onCleanup)

    // Main resolved the runtime itself; the renderer never shows a feed.
    expect(pane.manager.getBackendSnapshot('pi-pane')).toMatchObject({ kind: 'pi', providerRuntime: 'terminal' })
    for (const globalMode of ['agent', 'hybrid', 'terminal'] as const) {
      expect(getEffectiveAgentSurfaceForSession({ kind: 'pi', providerRuntime: pane.meta().providerRuntime, globalMode, override: undefined, runtime: pane.runtime() })).toBe('terminal')
    }

    await played(pane, lastAnswer(branch))
    // While the recorded turns ran, every surface said so.
    const running = pane.timeline.filter(view => view.sessionStatus === 'running')
    expect(running.length).toBeGreaterThan(0)
    expect(running.every(view => view.headerLit)).toBe(true)
    expect(running.some(view => view.lifecycle === 'running')).toBe(true)
    // …and then all of them say it is done.
    expect(pane.surfaces()).toMatchObject({ sessionStatus: 'idle', headerLit: false, lifecycle: 'completed', copyLastResponse: lastAnswer(branch) })
    // The conversation is the recording's: its typed prompts, in order.
    expect(userEntries(pane)).toEqual(typedPrompts(branch))
    // The pane learned its native identity from pi, and main knows its file.
    expect(pane.meta().providerSessionId).toBe(fixture.sessionIdLaunched)
    expect(pane.manager.getTranscriptFile('pi-pane')).toBe(pane.sandbox.mapPath(Object.keys(fixture.files)[0]!))
    expect(managedTranscriptUnavailableReason(pane.runtime(), pane.meta())).toBeNull()
  })

  it('/new inside pi: the pane follows into the new session, its conversation resets, and main serves the new file', async () => {
    const fixture = loadLiveFixture('new-session')
    const starts = fixture.events.filter(event => event.name === 'session_start')
    const second = starts[1]!
    const secondRows = referenceActiveBranch(fixture.files[second.sessionFile as string]!)
    const pane = await startRecordedPiPane(fixture, onCleanup)
    await played(pane, lastAnswer(secondRows))

    expect(pane.meta().providerSessionId).toBe(second.sessionId)
    // Only the new session's conversation is on screen; the first one's
    // prompts are gone with its history window.
    expect(userEntries(pane)).toEqual(typedPrompts(secondRows))
    expect(pane.manager.getTranscriptFile('pi-pane')).toBe(pane.sandbox.mapPath(second.sessionFile as string))
    expect(pane.channels).toContain('session:provider-session-changed')
  })

  // Astra review finding 2: a history reset clears the dedup set, and the
  // trimmed-uuid ledger must go with it (liveEntryWindow's lifecycle note:
  // trimmed ⊆ ever-seen). Otherwise a /tree back to a branch the live window
  // had trimmed replays rows the live path then rejects as trimmed, and the
  // pane shows a gap. Standing in for "the window trimmed them earlier",
  // every row id in the recording is marked trimmed before it plays; the
  // reset /new causes must lift that, so the new session's turn is shown.
  it('a history reset forgets trimmed rows, so the replayed conversation is not dropped', async () => {
    const fixture = loadLiveFixture('new-session')
    const second = fixture.events.filter(event => event.name === 'session_start')[1]!
    const secondRows = referenceActiveBranch(fixture.files[second.sessionFile as string]!)
    const everyId = Object.values(fixture.files).flatMap(rows => referenceActiveBranch(rows).map(row => `pi:${row.id as string}`))
    const pane = await startRecordedPiPane(fixture, onCleanup)
    markUuidsTrimmed('pi-pane', everyId)
    onCleanup(() => clearLiveEntryWindowSession('pi-pane'))
    await played(pane, lastAnswer(secondRows))
    expect(userEntries(pane)).toEqual(typedPrompts(secondRows))
  })

  it('a dialog pi raises (an extension confirm) is attention on the pane while it is up, and clears after', async () => {
    const fixture = loadLiveFixture('dialog')
    const opened = fixture.events.find(event => event.name === 'ui_prompt_start')!
    const pane = await startRecordedPiPane(fixture, onCleanup)
    await pane.play()
    await waitFor(() => pane.conditionTimeline.some(kinds => kinds.includes('pi.dialog')), 'the dialog condition')
    await waitFor(() => !(pane.conditionTimeline.at(-1) ?? []).includes('pi.dialog'), 'the dialog to close')
    const upAt = pane.conditionTimeline.findIndex(kinds => kinds.includes('pi.dialog'))
    // While it was up, the Dispatch row asked the user (Pi's policy labels a
    // dialog QUESTION: pi is asking, and only the user can answer in the TUI).
    expect(pane.timeline[upAt]!.dispatchBadge).toBe('QUESTION')
    // Once pi closed it, nothing asks any more.
    expect(pane.surfaces().dispatchBadge).not.toBe('QUESTION')
    // The pane never answers it: pi's user does (spec rule: never auto-answer).
    expect(pane.pty.writes).toEqual([])
    expect(opened.title).toBe('Probe dialog')
  })

  it('without its bridge the pane still shows pi’s conversation, warns once and stickily, and never calls the transcript broken', async () => {
    const fixture = loadLiveFixture('tool')
    const branch = branchOf(fixture)
    const pane = await startRecordedPiPane(fixture, onCleanup, { noBridge: true })
    await pane.play()
    await waitFor(() => userEntries(pane).length === typedPrompts(branch).length, 'the durable rows via the directory scan')
    await waitFor(() => Boolean(pane.runtime().liveChannelWarning), 'the no-bridge warning')
    pane.flushMain()
    expect(pane.runtime().liveChannelWarning).toContain('(provider_bridge_unreachable)')
    // Rows kept arriving after the warning, and it is still up.
    expect(userEntries(pane)).toEqual(typedPrompts(branch))
    expect(pane.surfaces().copyLastResponse).toBe(lastAnswer(branch))
    // A parent reading this child gets its conversation, not "unavailable".
    expect(pane.runtime().transcriptStatus).not.toBe('error')
    expect(managedTranscriptUnavailableReason(pane.runtime(), pane.meta())).toBeNull()
  })
})
