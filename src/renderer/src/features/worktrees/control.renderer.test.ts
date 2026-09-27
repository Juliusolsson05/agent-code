import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/hook'
import { worktreeControlCapabilities } from './control'

// #1429 review a, b: the worktrees.read control capability projected only
// gitUnavailable and gitMissing, so a timed-out `git worktree list` reached an
// agent as "not a repository". The REAL capability and the REAL
// loadWorktreeDump; window.api is the stubbed edge, answering what main
// answers for a timeout (see src/main/ipc/git.timeout.test.ts).

const originalStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  useAppStore.setState(originalStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

async function read(gitResult: unknown) {
  Object.defineProperty(window, 'api', { configurable: true, value: { gitWorktreeStatus: vi.fn(async () => gitResult) } })
  useAppStore.setState({ workspaceState: { ...originalStore.workspaceState, sessions: { agent: { cwd: '/repo', kind: 'claude' } } } } as never)
  const workspace = { state: { tabs: [], sessions: {} }, runtimes: {} } as unknown as Workspace
  const [capability] = worktreeControlCapabilities(() => workspace)
  // execute(), the real entry point: it also validates the output schema, so
  // a field the schema drops would fail here too.
  const result = await capability!.execute({ sessionId: 'agent' }, {} as never)
  expect(result.ok).toBe(true)
  return (result as { value: Record<string, unknown> }).value
}

describe('worktrees.read and a git timeout', () => {
  it('tells a timeout apart from "not a repository"', async () => {
    expect(await read({ ok: false, gitMissing: false, timedOut: true })).toMatchObject({ gitUnavailable: true, gitMissing: false, gitTimedOut: true })
    expect(await read({ ok: false, gitMissing: false })).toMatchObject({ gitUnavailable: true, gitMissing: false, gitTimedOut: false })
  })
})

// #1430: git answered the status, but listing worktrees for the activity index
// then timed out. That used to read as "activity unavailable", the same as a
// missing index; it now says the git timeout, to agents and in the dump.
describe('worktrees.read when the activity lookup times out', () => {
  async function readWithActivity(activity: unknown) {
    const gitWorktreeStatus = vi.fn(async () => ({ ok: true, worktrees: [] }))
    Object.defineProperty(window, 'api', { configurable: true, value: { gitWorktreeStatus, worktreeActivitySummary: vi.fn(async () => activity) } })
    useAppStore.setState({ workspaceState: { ...originalStore.workspaceState, sessions: { agent: { cwd: '/repo', kind: 'claude' } } } } as never)
    const workspace = { state: { tabs: [], sessions: {}, pinnedSessionIds: [] }, runtimes: {} } as unknown as Workspace
    const [capability] = worktreeControlCapabilities(() => workspace)
    const result = await capability!.execute({ sessionId: 'agent' }, {} as never)
    expect(result.ok).toBe(true)
    return (result as { value: Record<string, unknown> }).value
  }

  it('says a git timeout apart from a missing activity index', async () => {
    expect(await readWithActivity({ ok: false, timedOut: true })).toMatchObject({ activityUnavailable: true, activityTimedOut: true })
    expect(await readWithActivity({ ok: false })).toMatchObject({ activityUnavailable: true, activityTimedOut: false })
  })

  it('and the text dump says it too', async () => {
    const { formatWorktreeDump } = await import('./lib/formatWorktreeDump')
    const base = { cwd: '/repo', generatedAt: 0, rows: [], indexStatus: null, gitUnavailable: false, gitMissing: false, activityUnavailable: true }
    expect(formatWorktreeDump({ ...base, activityTimedOut: true } as never)).toContain('- Agent activity: unavailable (Git timed out)')
    expect(formatWorktreeDump(base as never)).toContain('- Agent activity: unavailable\n')
  })
})
