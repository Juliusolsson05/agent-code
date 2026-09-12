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

import { loadLiveFixture, playReplay, type ReplayStep } from 'opencode-terminal-headless/testing'

import type { ConditionCustomAction } from '@shared/types/providerConditions'
import { entryTextContent } from '@renderer/session-runtime/entries'

import { opencodeTerminalPanes, type PaneSurfaces, type RecordedPane } from './testing/opencodeTerminalPane'
import { opencodeTerminalScope, SESSION_ID, waitFor } from './testing/opencodeTerminalScope'

// What a user and an orchestrating parent see of an OpenCode Terminal pane
// while a recorded TUI session plays through the real stack (see
// testing/opencodeTerminalPane.tsx for exactly what is real). This is the
// regression #857 describes (permanently idle) and #864's acceptance
// criteria, asserted at the surfaces rather than on runtime fields.
//
// Oracles are the recordings themselves: the prompt each one typed, the answer
// OpenCode committed (read from the fixture by hand, not through the mapper),
// and the permission id it asked with.

const panes = opencodeTerminalPanes(opencodeTerminalScope())

// Hand-read from the recordings' committed text parts.
const PLAIN_ANSWER = 'pong'
const QUEUED_ANSWER = 'second'
const PERMISSION_ANSWER = '1 entry (`README.md`).'
const PERMISSION_REQUEST = 'per_08e0cef22001sA9v5ZhJ4csx9z'

const userTexts = (pane: RecordedPane): string[] =>
  pane.runtime().entries.filter(entry => entry.type === 'user').map(entry => entryTextContent(entry) ?? '')

// The turn has ended at every surface, and main holds nothing back: whatever
// its coalescers still had is delivered before the assertions read the pane.
async function turnEnded(pane: RecordedPane, finalAnswer: string): Promise<PaneSurfaces> {
  await waitFor(() => {
    const view = pane.surfaces()
    return view.sessionStatus === 'idle' && view.lifecycle === 'completed' && view.copyLastResponse === finalAnswer
  }, 'the turn to end with its answer')
  pane.flushMain()
  return pane.surfaces()
}

const runningViews = (pane: RecordedPane): PaneSurfaces[] => pane.timeline.filter(view => view.sessionStatus === 'running')

describe('an OpenCode Terminal pane driven by a recorded TUI session, end to end', () => {
  it('reports a fresh pane started, ready and waiting before its first prompt', async () => {
    const pane = await panes.startRecordedPane(loadLiveFixture('plain.json'))
    // Readiness is the adapter's first-paint grace crossing main's revisioned
    // readiness relay; nothing before the paint may claim it.
    await waitFor(() => pane.surfaces().inputReady, 'composer readiness')

    expect(pane.surfaces()).toMatchObject({
      processStatus: 'started',
      inputReady: true,
      sessionStatus: 'idle',
      headerLit: false,
      dispatchActivity: 'idle',
      dispatchBadge: null,
      // A parent's wait_agents must see a child it can prompt, not one that
      // was merely created; Agent Management must see a live backend.
      lifecycle: 'waiting',
      managedBackend: 'live',
      managedActivity: 'waiting',
    })
    expect(pane.surfaces().agentStatus).toMatchObject({ Process: 'started' })
    expect(pane.channels).toContain('session:started')
    expect(pane.channels).toContain('session:input-readiness')
  })

  it('lights every surface while the recorded turn runs, then reads idle, NEW and completed with the answer', async () => {
    const recording = loadLiveFixture('plain.json')
    const pane = await panes.startRecordedPane(recording)

    await playReplay(pane.script, pane.writer!, pane.server)
    const final = await turnEnded(pane, PLAIN_ANSWER)

    const running = runningViews(pane)
    expect(running.length).toBeGreaterThan(0)
    for (const view of running) {
      expect(view.headerLit).toBe(true)
      expect(['running', 'working']).toContain(view.dispatchActivity)
      expect(view.lifecycle).toBe('running')
      expect(view.managedActivity).toBe('running')
      expect(view.agentStatus.Session).toMatch(/^running/)
    }
    // The Dispatch subtitle shows the live stream phase while one is active.
    expect(running.some(view => view.streamPhase !== 'idle' && view.dispatchSubtitle === view.streamPhase)).toBe(true)

    // Answer before idle: the first idle view after the turn already carries
    // the committed answer, so no surface ever read "done, nothing to show".
    const lastRunning = pane.timeline.map(view => view.sessionStatus).lastIndexOf('running')
    expect(pane.timeline[lastRunning + 1]?.copyLastResponse).toBe(PLAIN_ANSWER)

    expect(final).toMatchObject({
      sessionStatus: 'idle',
      streamPhase: 'idle',
      headerLit: false,
      dispatchActivity: 'idle',
      dispatchSubtitle: 'idle',
      dispatchBadge: 'NEW',
      // The old runtime left children at "waiting" forever (#857).
      lifecycle: 'completed',
      managedActivity: 'completed',
      managedBackend: 'live',
      transcriptStatus: 'ready',
      copyLastResponse: PLAIN_ANSWER,
    })
    expect(final.agentStatus).toMatchObject({ Process: 'started', Transcript: 'ready', Activity: 'idle' })
    expect(userTexts(pane)).toContain(recording.prompts[0]!.text)
  })

  it('keeps a queued second prompt inside one running span and ends with both answers', async () => {
    const recording = loadLiveFixture('queued.json')
    const pane = await panes.startRecordedPane(recording)

    await playReplay(pane.script, pane.writer!, pane.server)
    const final = await turnEnded(pane, QUEUED_ANSWER)

    // Running never flickered to idle between the two prompts.
    const statuses = pane.timeline.map(view => view.sessionStatus)
    const firstRunning = statuses.indexOf('running')
    const lastRunning = statuses.lastIndexOf('running')
    expect(firstRunning).toBeGreaterThanOrEqual(0)
    expect(statuses.slice(firstRunning, lastRunning + 1).every(status => status === 'running')).toBe(true)

    expect(userTexts(pane)).toEqual(expect.arrayContaining(recording.prompts.map(prompt => prompt.text)))
    expect(final).toMatchObject({ lifecycle: 'completed', dispatchBadge: 'NEW', copyLastResponse: QUEUED_ANSWER })
  })

  it("answering through Agent Code's condition resolver clears ACTION, and the badge then reads NEW", async () => {
    const pane = await panes.startRecordedPane(loadLiveFixture('permission-once.json'))
    let atPermission: PaneSurfaces | null = null

    await playReplay(pane.script, pane.writer!, pane.server, {
      beforeStep: async (step: ReplayStep) => {
        if (atPermission || step.kind !== 'sse' || step.event.type !== 'permission.replied') return
        await waitFor(() => pane.surfaces().dispatchBadge === 'ACTION', 'the permission badge')
        atPermission = pane.surfaces()
        const once = pane.runtime().conditions!.conditions['opencode.permission']!.actions
          .find(action => action.label === 'Allow once') as ConditionCustomAction
        // The resolver external condition control calls (SessionManager →
        // adapter → the TUI's own server), not a pane button. The terminal
        // surface renders no answer buttons by decision, not by omission:
        // permissions and questions are answered in the TUI itself, on the
        // phone, or through MCP. Duplicating them in the pane would put two
        // live answer paths on one prompt.
        await expect(pane.manager.resolveCondition(SESSION_ID, once)).resolves.toEqual({ ok: true })
        expect(pane.server.calls).toContainEqual(expect.objectContaining({
          method: 'POST',
          path: `/permission/${PERMISSION_REQUEST}/reply`,
          authorized: true,
        }))
        await waitFor(() => pane.surfaces().dispatchBadge !== 'ACTION', 'ACTION to clear')
      },
    })
    const final = await turnEnded(pane, PERMISSION_ANSWER)

    expect(atPermission).toMatchObject({ sessionStatus: 'running', dispatchBadge: 'ACTION', unreadKind: 'attention' })
    // The runtime keeps its record that attention was raised while the user
    // was away (a later turn's output does not overwrite it) until they open
    // the pane. The Dispatch row does not repeat ACTION for a prompt that is
    // no longer pending: it reads NEW, the output that followed.
    expect(final.unreadKind).toBe('attention')
    expect(final.dispatchBadge).toBe('NEW')
    expect(final.lifecycle).toBe('completed')
  })

  it('shows the pane exited, not running, when the TUI dies mid-turn', async () => {
    const pane = await panes.startRecordedPane(loadLiveFixture('plain.json'))
    const busyAt = pane.script.findIndex(step => step.kind === 'sse' && step.event.type === 'session.status'
      && (step.event.properties?.status as { type: string }).type === 'busy')

    await playReplay(pane.script.slice(0, busyAt + 1), pane.writer!, pane.server)
    await waitFor(() => pane.surfaces().sessionStatus === 'running', 'the turn to start')
    pane.pty.exit(137, 9)
    await waitFor(() => pane.runtime().exited !== null, 'exit to reach the pane')
    pane.flushMain()

    // The closing turn arrived before exit, so nothing is left "running".
    expect(pane.surfaces()).toMatchObject({
      streamPhase: 'idle',
      headerLit: false,
      dispatchActivity: 'exited',
      dispatchSubtitle: 'exited',
      lifecycle: 'closed',
      managedBackend: 'hibernated',
      processStatus: 'exited',
      inputReady: false,
    })
    expect(pane.surfaces().sessionStatus).not.toBe('running')
  })
})
