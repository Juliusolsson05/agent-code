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

async function mount(identities: Record<string, string> = {}) {
  const manager = new EventEmitter()
  const recorder = new AgentActivityRecorder({
    manager: manager as unknown as Pick<SessionManager, 'on'>,
    store: new AgentActivityStore(dir),
    resolveRepoRoot: async cwd => cwd.split('/.worktrees/')[0],
    identityOf: sessionId => identities[sessionId],
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

  // Steering q63: an alias edge counts as written only once it is on disk.
  // A failed append (full or read-only disk) must leave it retryable on the
  // next projection; acknowledging it first meant a restart lost it and the
  // old session-id row split again.
  it('retries an alias whose append failed, so it survives a restart', async () => {
    const { mkdir, rmdir } = await import('node:fs/promises')
    const store = new AgentActivityStore(dir)
    await store.appendInterval({
      context: { agentKey: 'child', label: 'Reviewer', role: 'orchestration', provider: 'codex', tabId: 'tab-1', tabTitle: 'agent-code', repoRoot: '/dev/agent-code', cwd: '/dev/agent-code/.worktrees/fix' },
      startedAt: T0 - 2 * HOUR,
      endedAt: T0 - HOUR,
    })
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
    // A directory where the file should be makes every append fail.
    await mkdir(join(dir, 'aliases.jsonl'))
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    await recorder.flush()
    await rmdir(join(dir, 'aliases.jsonl'))
    // The next autosave projects the same workspace; the edge goes again.
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    phase('child', 'idle')
    await recorder.flush()

    // A restart reads only what is on disk.
    const restarted = new AgentActivityRecorder({
      manager: new EventEmitter() as unknown as Pick<SessionManager, 'on'>,
      store: new AgentActivityStore(dir),
      resolveRepoRoot: async cwd => cwd.split('/.worktrees/')[0],
    })
    recorders.push(restarted)
    const summary = await restarted.summary('24h')
    expect(summary.projects[0].topAgents.map(agent => [agent.label, agent.agentMs])).toEqual([['Reviewer', 2 * HOUR]])
  })

  // #1342 verification b: the successor finishes a turn and the app dies
  // before its row is ever saved, so no projection can alias it. Main got
  // the identity with the spawn, so the interval carries it from the start.
  it('keys a successor by the identity main got at spawn when its row never reaches main', async () => {
    const { manager, recorder, phase } = await mount({ 'child-2': 'tldr-reviewer' })
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    manager.emit('removed', { sessionId: 'child' })
    manager.emit('started', { sessionId: 'child-2', kind: 'codex' })
    phase('child-2', 'responding')
    vi.setSystemTime(T0 + 2 * HOUR)
    phase('child-2', 'idle')
    await recorder.flush()

    // A restart from the workspace as last saved: the successor is not in it.
    const restarted = new AgentActivityRecorder({
      manager: new EventEmitter() as unknown as Pick<SessionManager, 'on'>,
      store: new AgentActivityStore(dir),
      resolveRepoRoot: async cwd => cwd.split('/.worktrees/')[0],
    })
    recorders.push(restarted)
    const summary = await restarted.summary('24h')
    expect(summary.totals.agentMs).toBe(2 * HOUR)
    expect(summary.totals.agents.user + summary.totals.agents.orchestration).toBe(1)
  })

  // #1342 verification b and c: turning names on after a session already had
  // an identity gives the pane its own session id as its name, so the edges
  // point both ways (child -> tldr, then tldr -> child). One agent either way.
  it('keeps one agent when names are turned on after its identity was recorded', async () => {
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.child = { ...window.workspace.sessions.child, tldrIdentity: 'tldr-reviewer' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + HOUR)
    phase('child', 'idle')
    await recorder.flush()
    window.workspace.sessions.child = { ...window.workspace.sessions.child, agentNameId: 'child' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada', child: 'Bo' })
    phase('child', 'responding')
    vi.setSystemTime(T0 + 2 * HOUR)
    phase('child', 'idle')

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents.orchestration).toBe(1)
    expect(summary.totals.agentMs).toBe(2 * HOUR)
  })

  // #1342 verification b (round 3): a named agent with a tldrIdentity has an
  // alias group whose representative is not its name. A closed hour went
  // through the group while the turn still open kept its raw key, so the
  // summary showed one working agent as two until the turn closed.
  it('counts a working agent once when its closed and open intervals are keyed differently before grouping', async () => {
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.lead = { ...window.workspace.sessions.lead, tldrIdentity: 'tldr-lead' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('lead', 'thinking')
    vi.setSystemTime(T0 + HOUR)
    phase('lead', 'idle')
    phase('lead', 'thinking')
    vi.setSystemTime(T0 + 2 * HOUR)

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents.user).toBe(1)
    expect(summary.projects[0].topAgents.map(agent => [agent.label, agent.agentMs])).toEqual([['Ada', 2 * HOUR]])
  })

  // #1342 verification b (round 4): an autosave can save an alias while a
  // summary is reading. Closed and open intervals must be keyed by the same
  // alias snapshot, or they get different representatives for one agent.
  it('keys closed and open intervals by one alias snapshot when an alias lands mid-summary', async () => {
    const store = new AgentActivityStore(dir)
    const manager = new EventEmitter()
    const recorder = new AgentActivityRecorder({
      manager: manager as unknown as Pick<SessionManager, 'on'>,
      store,
      resolveRepoRoot: async cwd => cwd.split('/.worktrees/')[0],
    })
    recorders.push(recorder)
    await recorder.start()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.lead = { ...window.workspace.sessions.lead, tldrIdentity: 'tldr-lead' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    manager.emit('started', { sessionId: 'lead', kind: 'claude' })
    const phase = (value: string) => manager.emit('semantic-event', { sessionId: 'lead', event: { type: 'stream_phase', phase: value } })
    phase('thinking')
    vi.setSystemTime(T0 + HOUR)
    phase('idle')
    phase('thinking')
    vi.setSystemTime(T0 + 2 * HOUR)
    await recorder.flush()
    // The autosave lands after the closed intervals were read: another pane
    // of the same named agent ('a' sorts before every other key in the group).
    const read = store.readIntervals.bind(store)
    vi.spyOn(store, 'readIntervals').mockImplementation(async (...args) => {
      const intervals = await read(...args)
      await store.appendAliases([['a', 'name-1']])
      return intervals
    })

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents.user).toBe(1)
    expect(summary.projects[0].topAgents.map(agent => agent.agentMs)).toEqual([2 * HOUR])
  })

  // #1342 verification b (round 5, surviving mutant): the alias can also land
  // after the summary's snapshot but BEFORE the closed intervals are read.
  // Only passing that snapshot into readIntervals keeps both sets on it.
  it('keys closed intervals by the summary\'s snapshot even when an alias lands before they are read', async () => {
    const store = new AgentActivityStore(dir)
    const manager = new EventEmitter()
    const recorder = new AgentActivityRecorder({
      manager: manager as unknown as Pick<SessionManager, 'on'>,
      store,
      resolveRepoRoot: async cwd => cwd.split('/.worktrees/')[0],
    })
    recorders.push(recorder)
    await recorder.start()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.lead = { ...window.workspace.sessions.lead, tldrIdentity: 'tldr-lead' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    manager.emit('started', { sessionId: 'lead', kind: 'claude' })
    const phase = (value: string) => manager.emit('semantic-event', { sessionId: 'lead', event: { type: 'stream_phase', phase: value } })
    phase('thinking')
    vi.setSystemTime(T0 + HOUR)
    phase('idle')
    phase('thinking')
    vi.setSystemTime(T0 + 2 * HOUR)
    await recorder.flush()
    const read = store.readIntervals.bind(store)
    vi.spyOn(store, 'readIntervals').mockImplementation(async (...args) => {
      await store.appendAliases([['a', 'name-1']])
      return read(...args)
    })

    const summary = await recorder.summary('24h')
    expect(summary.totals.agents.user).toBe(1)
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

  // Rows already written for a named agent are keyed by its name. An agent
  // that also has a tldrIdentity must stay ONE agent with that history: the
  // name is its key, and the alias groups it with its tldrIdentity and session
  // id, so which of them represents the group does not matter (the key is
  // only a grouping and React key).
  it('counts a named agent with a tldrIdentity as the agent its name already keys', async () => {
    const { recorder, phase } = await mount()
    const [window] = windows() as unknown as Array<{ workspace: { sessions: Record<string, Record<string, unknown>> } }>
    window.workspace.sessions.lead = { ...window.workspace.sessions.lead, tldrIdentity: 'tldr-lead' }
    recorder.updateWorkspace([window] as unknown as PersistedWindow[], { 'name-1': 'Ada' })
    phase('lead', 'thinking')
    vi.setSystemTime(T0 + HOUR)
    phase('lead', 'idle')
    const summary = await recorder.summary('24h')
    expect(summary.projects[0].topAgents.map(agent => [agent.label, agent.agentMs])).toEqual([['Ada', HOUR]])
    expect(summary.totals.agents.user).toBe(1)
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
