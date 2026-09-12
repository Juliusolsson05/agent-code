import { describe, expect, it } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { agentFollowEnabled } from './agentFollow'

const workingMode = { tailAllMode: false, tailWorkingMode: true }

describe('working-agent follow policy', () => {
  it.each([
    ['idle', {}, false],
    ['submitted before first token', { sessionStatus: 'running' }, true],
    ['streaming between process observations', { streamPhase: 'responding' }, true],
    ['waiting on tools', { streamPhase: 'awaiting-tool' }, true],
    ['started but idle process', { processStatus: 'started' }, false],
    ['exited with stale stream', { exited: 0, streamPhase: 'responding' }, false],
    ['process exit before runtime exit code', { processStatus: 'exited', sessionStatus: 'running' }, false],
    ['failed with stale busy state', { processStatus: 'failed', sessionStatus: 'running' }, false],
  ] satisfies Array<[string, Partial<SessionRuntime>, boolean]>)('%s', (_name, patch, expected) => {
    for (const kind of ['claude', 'codex', 'opencode', undefined]) {
      expect(agentFollowEnabled(kind, { ...emptyRuntime(), ...patch }, workingMode)).toBe(expected)
    }
  })

  it('excludes busy shells but preserves their existing individual and All Visible policies', () => {
    const runtime = { ...emptyRuntime(), sessionStatus: 'running' as const }
    expect(agentFollowEnabled('terminal', runtime, workingMode)).toBe(false)
    expect(agentFollowEnabled('terminal', { ...runtime, tailMode: true }, workingMode)).toBe(true)
    expect(agentFollowEnabled('terminal', runtime, { tailAllMode: true, tailWorkingMode: false })).toBe(true)
  })

  it('releases idle agents without clearing an individually enabled follower', () => {
    expect(agentFollowEnabled('claude', emptyRuntime(), workingMode)).toBe(false)
    expect(agentFollowEnabled('claude', { ...emptyRuntime(), tailMode: true }, workingMode)).toBe(true)
  })
})
