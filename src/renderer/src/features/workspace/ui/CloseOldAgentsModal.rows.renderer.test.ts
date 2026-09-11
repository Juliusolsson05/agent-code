import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { buildAgentRows } from './CloseOldAgentsModal'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'

// Close Old Agents aged sessions by transcript timestamps, which shells do not
// have, so terminals were excluded outright. The foreground monitor (#865) gives
// them an age: the last time a command started, finished or the shell cd'd.
it('ages an idle terminal from its last foreground change', () => {
  const state: Workspace['state'] = {
    tabs: [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId: 'shell' }, focusedSessionId: 'shell' }],
    activeTabId: 'tab', dispatchMode: null, gridRelatedSelections: {},
    sessions: { shell: { cwd: '/work/api', kind: 'terminal' } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [],
  }
  const runtimes = {
    shell: { ...emptyRuntime(), terminalForeground: { busy: false, command: 'zsh', cwd: '/work/api', changedAt: 1_000 } },
  } as Workspace['runtimes']

  expect(buildAgentRows(state, runtimes, 61_000)).toEqual([
    expect.objectContaining({ sessionId: 'shell', kind: 'terminal', lastActiveAt: 1_000, ageMs: 60_000, isLive: false }),
  ])
})

describe('cleanup activity evidence (#886)', () => {
  const now = Date.parse('2026-09-11T12:00:00Z')
  const old = now - 8 * 60 * 60 * 1000
  const recent = now - 60_000
  const state: Workspace['state'] = {
    activeTabId: 'tab', dispatchMode: null, buried: [], pinnedSessionIds: [],
    tabs: [{ id: 'tab', title: 'project', root: { type: 'leaf', sessionId: 'agent' }, focusedSessionId: 'agent' }],
    sessions: { agent: { cwd: '/project', kind: 'claude' } }, detachedSessions: {},
  }
  // Timestamps are the public transcript fields cleanup reads. The provider's
  // content is deliberately irrelevant to whether the session is old.
  const entry = (at: number): Entry => ({ timestamp: new Date(at).toISOString() } as Entry)
  const row = (patch: Partial<SessionRuntime>) => buildAgentRows(state, {
    agent: { ...emptyRuntime(), entries: [entry(old)], ...patch },
  }, now)[0]

  it.each(['turnStartedAt', 'phaseChangedAt', 'submittedAt', 'lastJsonlEntryAt'] as const)(
    'newer %s defeats an old transcript', field => {
      expect(row({ [field]: recent })).toMatchObject({ lastActiveAt: recent, ageMs: 60_000 })
    },
  )
  it('uses the newest timestamp even when transcript records arrive out of order', () => {
    expect(row({ entries: [entry(recent), entry(old)] }).lastActiveAt).toBe(recent)
  })
  it('treats process activity as working even before derived status catches up', () => {
    expect(row({ processActive: true, sessionStatus: 'idle', streamPhase: 'idle' }).isLive).toBe(true)
  })
  it.each([
    { bootstrapping: true }, { processStatus: 'spawning' as const },
    { transcriptStatus: 'loading' as const }, { entries: [] },
  ])('does not infer inactivity from incomplete evidence: %j', patch => {
    expect(row(patch).ageMs).toBeNull()
  })
})
