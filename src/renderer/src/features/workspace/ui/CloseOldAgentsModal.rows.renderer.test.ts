import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { buildAgentRows } from './CloseOldAgentsModal'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// Close Old Agents aged sessions by transcript timestamps, which shells do not
// have, so terminals were excluded outright. #865 aged them by the runtime's
// last foreground change — but a restart re-stamps that to "now" for every
// shell, so after a restart no terminal could be old (#1178). They now age by
// the durable `lastUsedAt` record on their metadata.
it('ages an idle terminal from its durable last-used record', () => {
  const state: Workspace['state'] = {
    tabs: [{ id: 'tab', title: 'project' }],
    activeTabId: 'tab', stage: oneLaneStage('shell'),
    sessions: { shell: { cwd: '/work/api', kind: 'terminal', projectId: 'tab', joinedAt: 0, lastUsedAt: 1_000 } },
    pinnedSessionIds: [],
  }
  const runtimes = {
    shell: { ...emptyRuntime(), terminalForeground: { busy: false, command: 'zsh', cwd: '/work/api', changedAt: 1_000 } },
  } as Workspace['runtimes']

  // The age is read from the record's upper bound (record + one throttle
  // resolution): a use dropped by the throttle can be up to a minute later
  // than the record, and a destructive filter must not call that shell old.
  expect(buildAgentRows(state, runtimes, 121_000)).toEqual([
    expect.objectContaining({ sessionId: 'shell', kind: 'terminal', lastActiveAt: 61_000, ageMs: 60_000, isLive: false }),
  ])
})

it('still finds a terminal that sat unused for days right after a restart (#1178)', () => {
  // The restart: the foreground snapshot was just folded into an empty
  // runtime, so changedAt is NOW. The shell was last used three days ago.
  const now = Date.parse('2026-09-25T12:00:00Z')
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000
  const state: Workspace['state'] = {
    tabs: [{ id: 'tab', title: 'project' }],
    activeTabId: 'tab', stage: oneLaneStage('shell'),
    sessions: { shell: { cwd: '/work/api', kind: 'terminal', projectId: 'tab', joinedAt: 0, lastUsedAt: threeDaysAgo } },
    pinnedSessionIds: [],
  }
  const runtimes = {
    shell: { ...emptyRuntime(), terminalForeground: { busy: false, command: 'zsh', cwd: '/work/api', changedAt: now } },
  } as Workspace['runtimes']

  expect(buildAgentRows(state, runtimes, now)).toEqual([
    expect.objectContaining({ sessionId: 'shell', lastActiveAt: threeDaysAgo + 60_000, ageMs: now - threeDaysAgo - 60_000, isLive: false }),
  ])
})

it('ages a parked terminal whose runtime was never rebuilt, but never calls it idle', () => {
  // A pooled shell that has not been woken since the restart has no runtime.
  // Its record is metadata, so it still has an age instead of "unknown" — but
  // nobody is watching its foreground, so it may be running a dev server
  // (review of #1179). Unknown liveness counts as running: excluded unless the
  // user ticks Include running.
  const state: Workspace['state'] = {
    tabs: [{ id: 'tab', title: 'project' }],
    activeTabId: 'tab', stage: oneLaneStage(),
    sessions: { shell: { cwd: '/work/api', kind: 'terminal', projectId: 'tab', joinedAt: 0, lastUsedAt: 1_000 } },
    pinnedSessionIds: [],
  }
  expect(buildAgentRows(state, {} as Workspace['runtimes'], 121_000)).toEqual([
    expect.objectContaining({ sessionId: 'shell', lastActiveAt: 61_000, ageMs: 60_000, isLive: true, livenessUnknown: true }),
  ])
})

describe('cleanup activity evidence (#886)', () => {
  const now = Date.parse('2026-09-11T12:00:00Z')
  const old = now - 8 * 60 * 60 * 1000
  const recent = now - 60_000
  const state: Workspace['state'] = {
    activeTabId: 'tab', stage: oneLaneStage('agent'),  pinnedSessionIds: [],
    tabs: [{ id: 'tab', title: 'project' }],
    sessions: { agent: { cwd: '/project', kind: 'claude', projectId: 'tab', joinedAt: 0 } }, 
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
  it('keeps an agent recent when a newer record lands out of order, through the ingest watermark', () => {
    // #886 review m2: the transcript tail is scanned from the end and stops at
    // the first valid timestamp (a full O(n) scan ran on every streaming update
    // while the modal was open). Safety does not rest on the tail: ingesting
    // the out-of-order record advances lastJsonlEntryAt, and the newest of all
    // evidence wins.
    expect(row({ entries: [entry(recent), entry(old)], lastJsonlEntryAt: recent }).lastActiveAt).toBe(recent)
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
