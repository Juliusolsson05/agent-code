import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentActivityRecorder } from '@main/agentActivity/AgentActivityRecorder.js'
import { AgentActivityStore } from '@main/agentActivity/AgentActivityStore.js'
import type { SessionManager } from '@main/sessionManager.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'

// The recorder end to end (#964): manager events in, the summary the Agent
// Analytics window paints out, with a real store on disk. Only the session manager
// is a plain emitter and the clock is simulated.

const HOUR = 3_600_000
const MINUTE = 60_000
const T0 = Date.parse('2026-09-10T09:00:00Z')

/** One window: tab "agent-code" holds a Claude lead and a terminal in its grid, and
 *  the lead's orchestration child (Codex, in a worktree) sits in Dispatch. */
function windows(): PersistedWindow[] {
  return [{
    windowId: 'window-1',
    workspace: {
      sessions: {
        lead: { kind: 'claude', cwd: '/dev/agent-code', agentNameId: 'name-1' },
        child: { kind: 'codex', cwd: '/dev/agent-code/.worktrees/fix', title: 'Reviewer', orchestrationParentId: 'lead' },
        shell: { kind: 'terminal', cwd: '/dev/agent-code' },
      },
      tabs: [{
        id: 'tab-1',
        title: 'agent-code',
        root: { type: 'split', direction: 'row', ratio: 0.5, a: { type: 'leaf', sessionId: 'lead' }, b: { type: 'leaf', sessionId: 'shell' } },
        focusedSessionId: 'lead',
      }],
      detachedSessions: {
        child: { sessionId: 'child', surface: 'dispatch', projectTabId: 'tab-1', projectTabTitle: 'agent-code', projectTabIndex: 0, detachedAt: T0 },
      },
      buried: [],
    },
  }] as unknown as PersistedWindow[]
}

let dir: string
const recorders: AgentActivityRecorder[] = []

async function mount() {
  const manager = new EventEmitter()
  const recorder = new AgentActivityRecorder({
    manager: manager as unknown as Pick<SessionManager, 'on'>,
    store: new AgentActivityStore(dir),
    resolveRepoRoot: async cwd => cwd.split('/.worktrees/')[0],
  })
  recorders.push(recorder)
  await recorder.start()
  recorder.updateWorkspace(windows(), { 'name-1': 'Ada' })
  const phase = (sessionId: string, value: string): void => {
    manager.emit('semantic-event', { sessionId, event: { type: 'stream_phase', phase: value } })
  }
  const permission = (sessionId: string, visible: boolean): void => {
    manager.emit('conditions', {
      sessionId,
      snapshot: { provider: 'claude', conditions: visible ? { 'claude.permission-prompt': { state: { visible: true } } } : {} },
    })
  }
  for (const [sessionId, kind] of [['lead', 'claude'], ['child', 'codex'], ['shell', 'terminal']]) {
    manager.emit('started', { sessionId, kind })
  }
  return { manager, recorder, phase, permission }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-activity-recorder-'))
  // Only Date is simulated: the store's file I/O must run for real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(async () => {
  for (const recorder of recorders.splice(0)) recorder.stop()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('AgentActivityRecorder', () => {
  it('records each agent under its tab, pauses while one waits on a permission prompt, and ignores terminals', async () => {
    const { recorder, phase, permission } = await mount()
    phase('lead', 'thinking')
    phase('shell', 'responding')
    vi.setSystemTime(T0 + 30 * MINUTE)
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    permission('lead', true)
    vi.setSystemTime(T0 + 90 * MINUTE)
    permission('lead', false)
    vi.setSystemTime(T0 + 2 * HOUR)
    phase('lead', 'idle')
    phase('child', 'idle')
    vi.setSystemTime(T0 + 3 * HOUR)

    const summary = await recorder.summary('24h')
    expect(summary.totals).toEqual({ agentMs: 3 * HOUR, wallMs: 2 * HOUR, agents: { user: 1, orchestration: 1 } })
    const [project] = summary.projects
    expect(project.title).toBe('agent-code')
    expect(project.open).toBe(true)
    expect(project.topAgents.map(agent => [agent.label, agent.provider, agent.role, agent.agentMs])).toEqual([
      ['Ada', 'claude', 'user', 1.5 * HOUR],
      ['Reviewer', 'codex', 'orchestration', 1.5 * HOUR],
    ])
    expect(project.repositories.map(repository => [repository.repoRoot, repository.worktrees.length])).toEqual([['/dev/agent-code', 2]])
  })

  it('closes an agent removed mid-turn at removal, and counts one still working up to now', async () => {
    const { manager, recorder, phase } = await mount()
    phase('lead', 'thinking')
    phase('child', 'thinking')
    vi.setSystemTime(T0 + HOUR)
    manager.emit('removed', { sessionId: 'lead' })
    vi.setSystemTime(T0 + 2 * HOUR)

    const summary = await recorder.summary('24h')
    expect(summary.projects[0].topAgents.map(agent => [agent.label, agent.agentMs])).toEqual([
      ['Reviewer', 2 * HOUR],
      ['Ada', HOUR],
    ])
  })

  it('does not count the machine sleeping during a turn', async () => {
    const { recorder, phase } = await mount()
    phase('lead', 'thinking')
    vi.setSystemTime(T0 + 4 * HOUR)
    recorder.noteSuspension({ suspendedAt: T0 + HOUR, resumedAt: T0 + 3 * HOUR, source: 'power-monitor' })
    phase('lead', 'idle')

    expect((await recorder.summary('24h')).totals.agentMs).toBe(2 * HOUR)
  })

  it('after a crash, the next launch counts only up to the last save, not the hours the app was gone', async () => {
    const first = await mount()
    first.phase('lead', 'thinking')
    vi.setSystemTime(T0 + 10 * MINUTE)
    // The child starting is a save of the open intervals at T0+10m — the crashed
    // run's last sign of life.
    first.phase('child', 'thinking')
    await first.recorder.flush()
    first.recorder.stop()

    vi.setSystemTime(T0 + 10 * HOUR)
    const next = await mount()
    const summary = await next.recorder.summary('24h')
    expect(summary.totals.agentMs).toBe(10 * MINUTE)
  })
})
