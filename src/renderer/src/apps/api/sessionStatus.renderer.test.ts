import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
import { projectSessionStatus, sessionStatusSignature } from '@renderer/apps/api/sessionStatus'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { dispatchUnreadBadge } from '@renderer/session-runtime/unreadBadge'
import { sessionIsWorking } from '@renderer/session-runtime/working'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

// #1479: extensions see the same "working" and the same badge as Dispatch.
// These tests pin the contract an extension author codes against (the SDK
// mirror marks the fields optional, this host always sends them) and the one
// property that keeps the feature cheap: streaming output alone never nudges.

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial) })

function runtime(patch: Partial<SessionRuntime>): SessionRuntime {
  return { ...emptyRuntime(), ...patch }
}

// Condition snapshots are shaped like the ones activityRow.test.ts uses for the
// Agent Activity "needs you" section; the labels come from the real Claude
// condition policy (providers/claude/renderer/conditions/policy.ts), so a
// policy change shows up here as a label change, not a silent pass.
const permissionPrompt = {
  provider: 'claude',
  ts: 1,
  conditions: { 'claude.permission-prompt': { kind: 'claude.permission-prompt', state: { visible: true }, actions: [] } },
} as unknown as ProviderConditionSnapshot

const askQuestion = {
  provider: 'claude',
  ts: 2,
  conditions: { 'claude.ask-user-question': { kind: 'claude.ask-user-question', state: { visible: true }, actions: [] } },
} as unknown as ProviderConditionSnapshot

const api = () => createAppHostApi({ extensionId: 'skitgubbe', closeSurface: () => {}, showToast: () => {} })

function seed(sessions: Record<string, { kind: string; title?: string }>, runtimes: Record<string, SessionRuntime>) {
  useAppStore.getState().setWorkspaceState(state => ({
    ...state,
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, meta]) => [
      id,
      { cwd: `/work/${id}`, kind: meta.kind, title: meta.title, projectId: 'p', joinedAt: 0 },
    ])) as typeof state.sessions,
  }))
  useAppStore.getState().setWorkspaceRuntimes(runtimes)
}

describe('projectSessionStatus agrees with Dispatch', () => {
  // Every runtime shape that changes either answer. The expected values are
  // NOT written out: the test asserts agreement with the two Dispatch rules,
  // because "the panel says what Dispatch says" is the requirement. The
  // explicit label checks below keep this from passing with both sides wrong.
  const cases: Array<[string, SessionRuntime | undefined]> = [
    ['no runtime (never observed, #880)', undefined],
    ['idle', runtime({})],
    ['streaming before status settles', runtime({ streamPhase: 'responding' })],
    ['running', runtime({ sessionStatus: 'running' })],
    ['finished, unseen', runtime({ unreadKind: 'output', unreadSince: 1 })],
    ['answered attention degrades to NEW', runtime({ unreadKind: 'attention', unreadSince: 1 })],
    ['live permission prompt', runtime({ sessionStatus: 'running', conditions: permissionPrompt })],
    ['failed start', runtime({ processError: 'claude exited before it was ready' })],
  ]
  for (const [name, rt] of cases) {
    it(name, () => {
      const projected = projectSessionStatus(rt)
      expect(projected.activity).toBe(sessionIsWorking(rt) ? 'working' : 'idle')
      const badge = rt ? dispatchUnreadBadge(rt) : null
      expect(projected.notification).toEqual(badge ? { kind: badge.kind, label: badge.text } : null)
    })
  }

  it('reports the words Dispatch paints', () => {
    expect(projectSessionStatus(runtime({ conditions: permissionPrompt })).notification)
      .toEqual({ kind: 'attention', label: 'ACTION' })
    expect(projectSessionStatus(runtime({ unreadKind: 'attention', unreadSince: 1 })).notification)
      .toEqual({ kind: 'output', label: 'NEW' })
    expect(projectSessionStatus(runtime({ processError: 'boom' })).notification)
      .toEqual({ kind: 'attention', label: 'ERROR' })
    expect(projectSessionStatus(runtime({ streamPhase: 'thinking' })).activity).toBe('working')
    expect(projectSessionStatus(undefined)).toEqual({ activity: 'idle', notification: null })
  })

  // The agreement table above cannot catch a precedence bug in the badge rule
  // itself (both sides call it). These pin the order the extension now
  // publishes (#1479 review, ub5/M15): a live prompt wins over a stale unread
  // marker AND over a leftover start error, because the prompt is what the
  // user can act on right now.
  it('a live prompt outranks an unread marker and a leftover error', () => {
    expect(projectSessionStatus(runtime({ unreadKind: 'attention', unreadSince: 1, conditions: permissionPrompt })).notification)
      .toEqual({ kind: 'attention', label: 'ACTION' })
    expect(projectSessionStatus(runtime({ processError: 'old failure', conditions: permissionPrompt })).notification)
      .toEqual({ kind: 'attention', label: 'ACTION' })
    expect(projectSessionStatus(runtime({ unreadKind: 'output', unreadSince: 1, processError: 'boom' })).notification)
      .toEqual({ kind: 'attention', label: 'ERROR' })
  })
})

describe('sessions.observe through the extension host API', () => {
  it('joins each session row with its runtime status', async () => {
    seed(
      { busy: { kind: 'claude', title: 'Refactor parser' }, done: { kind: 'codex' }, shell: { kind: 'terminal' } },
      {
        busy: runtime({ sessionStatus: 'running' }),
        done: runtime({ unreadKind: 'output', unreadSince: 5 }),
        // `shell` deliberately has no runtime: the row must still be listed.
      },
    )
    const rows = await api().sessions.observe()
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    expect(byId.busy).toEqual({
      id: 'busy', kind: 'claude', cwd: '/work/busy', title: 'Refactor parser',
      activity: 'working', notification: null,
    })
    expect(byId.done).toMatchObject({ activity: 'idle', notification: { kind: 'output', label: 'NEW' } })
    expect(byId.shell).toMatchObject({ kind: 'terminal', activity: 'idle', notification: null })
  })
})

describe('status change nudges', () => {
  it('sessions.subscribe fires on a working flip and a new badge, never on streamed entries alone', () => {
    seed({ a: { kind: 'claude' } }, { a: runtime({}) })
    let fired = 0
    const off = api().sessions.subscribe(() => { fired += 1 })
    try {
      const update = (patch: Partial<SessionRuntime>) =>
        useAppStore.getState().setWorkspaceRuntimes(prev => ({ ...prev, a: { ...prev.a!, ...patch } }))

      // A streamed chunk replaces the runtime map and the runtime object, as
      // the real transcript ingest does. Nothing an extension can see changed.
      update({ entries: [{ type: 'user', uuid: 'u1' } as unknown as SessionRuntime['entries'][number]] })
      expect(fired).toBe(0)

      update({ streamPhase: 'responding' })
      expect(fired).toBe(1)

      update({ entries: [] })
      expect(fired).toBe(1)

      update({ streamPhase: 'idle', unreadKind: 'output', unreadSince: 9 })
      expect(fired).toBe(2)
    } finally {
      off()
    }
  })

  it('fires when only the badge changes, the agent staying as busy as it was', () => {
    // #1479 review (ss4/ss5, M9/M10): every badge change above also flipped
    // activity, so dropping the badge from the signature survived. These are
    // the real cases where activity holds still.
    seed({ a: { kind: 'claude' } }, { a: runtime({ sessionStatus: 'running' }) })
    let fired = 0
    const off = api().sessions.subscribe(() => { fired += 1 })
    const update = (patch: Partial<SessionRuntime>) =>
      useAppStore.getState().setWorkspaceRuntimes(prev => ({ ...prev, a: { ...prev.a!, ...patch } }))
    try {
      // Mid-turn, a permission prompt appears: still working, now ACTION.
      update({ conditions: permissionPrompt })
      expect(fired).toBe(1)
      // The prompt turns into a question: same kind, different word.
      update({ conditions: askQuestion })
      expect(fired).toBe(2)
      // Idle with NEW, then the user looks and NEW clears: still idle.
      update({ conditions: null, sessionStatus: 'idle', unreadKind: 'output', unreadSince: 3 })
      expect(fired).toBe(3)
      update({ unreadKind: null, unreadSince: null })
      expect(fired).toBe(4)
    } finally {
      off()
    }
    // After unsubscribing nothing fires (ca3: a leaked status listener).
    update({ sessionStatus: 'running' })
    expect(fired).toBe(4)
  })

  it('adding a session calls the listener once, not once per source', () => {
    seed({ a: { kind: 'claude' } }, { a: runtime({}) })
    let fired = 0
    const off = api().sessions.subscribe(() => { fired += 1 })
    try {
      useAppStore.getState().setWorkspaceState(state => ({
        ...state,
        sessions: { ...state.sessions, b: { cwd: '/work/b', kind: 'codex', projectId: 'p', joinedAt: 0 } } as typeof state.sessions,
      }))
      expect(fired).toBe(1)
    } finally {
      off()
    }
  })

  it('the signature names sessions, so a replacement with the same status still changes it', () => {
    // A closes and B opens in the same tick, both working: positionally the
    // status list is identical. The id keeps the signature honest on its own;
    // the session-row listener would also fire here, but sessionStatusSignature
    // is documented as self-sufficient and this pins that claim.
    const state = (id: string) => ({
      workspaceState: { ...useAppStore.getState().workspaceState, sessions: { [id]: { cwd: '/x' } } },
      workspaceRuntimes: { [id]: runtime({ sessionStatus: 'running' }) },
    }) as unknown as Parameters<typeof sessionStatusSignature>[0]
    expect(sessionStatusSignature(state('a'))).not.toBe(sessionStatusSignature(state('b')))
  })
})
