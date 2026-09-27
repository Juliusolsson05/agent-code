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

  // #1302: names are off by default, so the key fell back to the session id,
  // and every reload, provider switch or MCP toggle (a new session id for the
  // same conversation) started a new analytics row. The renderer carries
  // tldrIdentity across exactly those replacements; 98 of the owner's 98
  // agents have one, 3 have a name.
  it('counts a replaced agent that keeps its conversation as one agent', async () => {
    const { manager, recorder, phase } = await mount()
    const layout = (childId: string) => {
      const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>>, detachedSessions: Record<string, Record<string, unknown>> } }>
      const child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
      delete window.workspace.sessions.child
      window.workspace.sessions[childId] = child
      const detached = { ...window.workspace.detachedSessions.child, sessionId: childId }
      delete window.workspace.detachedSessions.child
      window.workspace.detachedSessions[childId] = detached
      return [window] as unknown as PersistedWindow[]
    }
    recorder.updateWorkspace(layout('child'), { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    // Reload Agents: the old process goes, a successor with a new id resumes it.
    manager.emit('removed', { sessionId: 'child' })
    recorder.updateWorkspace(layout('child-2'), { 'name-1': 'Ada' })
    manager.emit('started', { sessionId: 'child-2', kind: 'codex' })
    phase('child-2', 'responding')
    vi.setSystemTime(T0 + 2 * HOUR)
    phase('child-2', 'idle')

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents).toEqual({ user: 0, orchestration: 1 })
    expect(summary.projects[0].topAgents.map(agent => [agent.label, agent.agentMs])).toEqual([['Reviewer', 2 * HOUR]])
  })

  // #1342 review b: the renderer saves the successor's row only after its
  // debounced autosave, so a successor can finish a turn while main still has
  // no placement for it. That interval is written under the bare session id;
  // the alias recorded when the row arrives joins it to the agent.
  it('joins a successor\'s turn that closed before its row was saved', async () => {
    const { manager, recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    manager.emit('started', { sessionId: 'child-2', kind: 'codex' })
    manager.emit('removed', { sessionId: 'child' })
    phase('child-2', 'responding')
    vi.setSystemTime(T0 + 2 * HOUR)
    phase('child-2', 'idle')
    await recorder.flush()
    // Only now does the successor's row reach main.
    window.workspace.sessions['child-2'] = window.workspace.sessions.child
    delete window.workspace.sessions.child
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })

    const summary = await recorder.summary('24h')
    expect(summary.totals.agentMs).toBe(2 * HOUR)
    expect(summary.totals.agents.user + summary.totals.agents.orchestration).toBe(1)
  })

  // #1342 review c: rows written before tldrIdentity was part of the key are
  // keyed by the session id. A still-live session's next interval must join
  // them instead of starting a second row at upgrade.
  it('joins rows recorded under a live session id before the identity was known', async () => {
    const store = new AgentActivityStore(dir)
    await store.appendInterval({
      context: { agentKey: 'child', label: 'Reviewer', role: 'orchestration', provider: 'codex', tabId: 'tab-1', tabTitle: 'agent-code', repoRoot: '/dev/agent-code', cwd: '/dev/agent-code/.worktrees/fix' },
      startedAt: T0 - 2 * HOUR,
      endedAt: T0 - HOUR,
    })
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    phase('child', 'idle')

    const summary = await recorder.summary('24h')
    expect(summary.projects[0].topAgents.map(agent => [agent.label, agent.agentMs])).toEqual([['Reviewer', 2 * HOUR]])
  })

  // An agent that gets a name later: its tldrIdentity rows join the name.
  it('joins an agent\'s earlier rows when it gets a name', async () => {
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    phase('child', 'idle')
    await recorder.flush()
    window.workspace.sessions.child = { ...window.workspace.sessions.child, agentNameId: 'name-2' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada', 'name-2': 'Bo' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + 2 * HOUR)
    phase('child', 'idle')

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents.orchestration).toBe(1)
    expect(summary.totals.agentMs).toBe(2 * HOUR)
  })

  // #1342 review c (surviving mutant): with neither a name nor an identity,
  // the session id is still the key, so two such agents stay two.
  it('keeps two agents with neither a name nor an identity apart', async () => {
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.lead = { kind: 'claude', cwd: '/dev/agent-code' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], {})
    phase('lead', 'thinking')
    phase('child', 'thinking')
    vi.setSystemTime(T0 + HOUR)
    phase('lead', 'idle')
    phase('child', 'idle')

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents).toEqual({ user: 1, orchestration: 1 })
  })

  // Rows already written for a named agent are keyed by its name; an agent
  // that has both keeps that key, so turning #1302's fallback on does not
  // split a named agent's history in two.
  it('keeps a named agent keyed by its name when it also has a tldrIdentity', async () => {
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.lead = { ...window.workspace.sessions.lead, tldrIdentity: 'tldr-lead' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('lead', 'thinking')
    vi.setSystemTime(T0 + HOUR)
    phase('lead', 'idle')
    const summary = await recorder.summary('24h')
    expect(summary.projects[0].topAgents.map(agent => agent.agentKey)).toEqual(['name-1'])
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
