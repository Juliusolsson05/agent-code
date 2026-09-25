import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionSpawnOptions } from '@preload/api/types'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { SUCCESSOR_RELATIONSHIP_FIELDS } from '@renderer/workspace/idRemap'
import { listOrchestrationAgents, readOrchestrationAgent } from '@renderer/workspace/orchestrationMcp'
import { buildOrchestrationBootstrapPrompt } from '@mcp/shared/orchestrationPrompt'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'

// #879. Reload, switch provider, resume or rewind an orchestration CHILD and
// the successor lost every relationship field — parent, root, run, role,
// `orchestrationBootstrapPromptDelivered`, `linkedParentId`.
//
// The consequence is the worst kind: the parent's next
// `orchestration_wait_agents({ runId })` returns `done: true, agents: [],
// outputs: []` WHILE THE CHILD IS STILL WORKING, because
// `isVisibleToOrchestrationParent` hides the successor and `done` is computed
// over that filtered list. An empty list reads as "all done". `read_agent`
// then fails, `close_run` misses it, and Dispatch shows it as a top-level row.
//
// `replaceSession` built the successor from spawn's fresh metadata plus title,
// identity and membership — and `remapSessionsRelationships` only fixes OTHER
// sessions that point AT the old id, never the swapped row's own outbound
// pointers. `reloadAgentSessions`, by contrast, spreads `...restoredMeta` and
// keeps everything, which is why this only showed up on one of the two paths.

vi.mock('./initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi; vi.useRealTimers() })

const CHILD: Partial<SessionMeta> = {
  orchestrationParentId: 'parent' as never,
  orchestrationRootId: 'parent' as never,
  orchestrationRunId: 'r1',
  orchestrationRole: 'reviewer',
  orchestrationBootstrapPromptDelivered: true,
  linkedParentId: 'parent' as never,
}

// ---------------------------------------------------------------------------
// Completeness guard, enforced by `tsc`, not by an assertion.
//
// The bug was an omission, so the defence has to be against omissions: every
// SessionMeta field whose NAME says it takes part in a relationship must be
// classified — carried by SUCCESSOR_RELATIONSHIP_FIELDS, or listed in
// `DELIBERATELY_NOT_CARRIED` below with the reason. Add a new
// `orchestration*` / `linked*` / `inherited*` field and forget both, and
// `UnclassifiedRelationshipField` stops being `never` and the build fails
// here. A runtime assertion could not do this: the keys of a TYPE do not
// exist at runtime, so a test could only re-list them, which is the same
// omission one file over.
//
// WHAT IT CANNOT CATCH, so nobody mistakes it for more than it is: the guard
// is NAME-shaped. A relationship pointer called something else —
// `supervisorSessionId`, say — is silently unprotected, and a reviewer
// verified that by adding one. A type-shaped guard is not available: `SessionId`
// is a bare `string` alias, so `SessionMeta[K] extends SessionId` matches every
// string field on the type and protects nothing. Prefixes are the only
// mechanism the type system offers here; the naming convention is therefore
// part of the contract, not a style preference.
// ---------------------------------------------------------------------------
type RelationshipField = Extract<
  keyof SessionMeta,
  `linked${string}` | `orchestration${string}` | `inherited${string}`
>
/** Nothing yet. Each entry added here needs a comment saying why a successor
 *  is better off WITHOUT the field. */
type DeliberatelyNotCarried = never
type UnclassifiedRelationshipField = Exclude<
  RelationshipField,
  (typeof SUCCESSOR_RELATIONSHIP_FIELDS)[number] | DeliberatelyNotCarried
>
type AssertNever<T extends never> = T
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _EveryRelationshipFieldIsClassified = AssertNever<UnclassifiedRelationshipField>

function setup(childMeta: Partial<SessionMeta> = CHILD) {
  vi.useFakeTimers()
  const state = {
    tabs: [{ id: 'project', title: 'Project' }],
    activeTabId: 'project',
    sessions: {
      parent: { cwd: '/project', kind: 'claude', projectId: 'project', joinedAt: 0 },
      child: { cwd: '/project', kind: 'codex', providerSessionId: 'native-child', projectId: 'project', joinedAt: 1, ...childMeta },
    },
    pinnedSessionIds: [],
    stage: oneLaneStage('child'),
  } as unknown as WorkspaceState
  const refs = makeRefs(state), writer = stateWriter(state, refs)
  refs.latestRuntimesRef.current = { child: { ...emptyRuntime(), processStatus: 'started' } }
  const setRuntimes = (update: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
    refs.latestRuntimesRef.current = typeof update === 'function' ? update(refs.latestRuntimesRef.current) : update
  }
  const spawnSession = vi.fn(async (options: SessionSpawnOptions) => ({ sessionId: 'successor', providerSessionId: options.resumeSessionId }))
  window.api = { ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), controlGoalLoop: vi.fn(async () => null) }
  const hook = renderHook(() => useSessionActions(state, writer.setState, setRuntimes, refs))
  return { writer, hook }
}

/** The runtime entry shape `entryTextContent` actually reads: a provider
 *  message with a text content block. */
function textEntry(type: 'user' | 'assistant', text: string) {
  return { type, message: { content: [{ type: 'text', text }] } } as never
}
const userEntry = (text: string) => textEntry('user', text)
const assistantEntry = (text: string) => textEntry('assistant', text)

async function replaceChild(hook: ReturnType<typeof setup>['hook']) {
  await act(async () => {
    await hook.result.current.replaceSession('/project', {
      kind: 'codex', targetSessionId: 'child' as never, resumeSessionId: 'native-child',
    })
    await vi.runAllTimersAsync()
  })
}

describe('a successor keeps the relationships that make it a child (#879)', () => {
  it('keeps parent, root, run and role, so the parent can still see it', async () => {
    const h = setup()

    await replaceChild(h.hook)

    const successor = h.writer.getState().sessions.successor
    expect(successor).toMatchObject({
      orchestrationParentId: 'parent',
      orchestrationRootId: 'parent',
      orchestrationRunId: 'r1',
      orchestrationRole: 'reviewer',
    })
  })

  it('is still returned by the parent\'s run-scoped listing, which is what wait_agents reads', async () => {
    // The assertion that matters. `done` is computed over this list, so an
    // empty one is reported to the parent as "every child finished".
    const h = setup()

    await replaceChild(h.hook)

    const listed = listOrchestrationAgents({
      state: h.writer.getState(),
      runtimes: {},
      parentSessionId: 'parent' as never,
      runId: 'r1',
    } as never)
    expect(listed.map(agent => agent.sessionId)).toEqual(['successor'])
  })

  it('keeps linkedParentId, so a cascade close still reaches it', async () => {
    const h = setup()

    await replaceChild(h.hook)

    expect(h.writer.getState().sessions.successor?.linkedParentId).toBe('parent')
  })

  it('keeps the bootstrap-delivered flag, so the parent does not re-send the brief', async () => {
    // Losing this is not cosmetic: the create path re-delivers a bootstrap
    // prompt to an agent that already has one, on top of whatever it is doing.
    const h = setup()

    await replaceChild(h.hook)

    expect(h.writer.getState().sessions.successor?.orchestrationBootstrapPromptDelivered).toBe(true)
  })

  it('keeps the inherited-context marker, so the parent does not read its own old commentary back as the child\'s answer', async () => {
    // Why this is not cosmetic metadata: `orchestrationVisibleEntries` cuts a
    // child's transcript at the LAST handoff marker, and it only does that
    // when `inheritedParentContext` and the bootstrap flag are BOTH true. A
    // child that inherited a duplicated parent transcript and then got
    // reloaded would, without the marker, report the parent's own pre-handoff
    // commentary as its latest message — the parent reads its own words back
    // as the worker's answer and acts on them.
    const h = setup({ ...CHILD, inheritedParentContext: true, inheritedParentProviderSessionId: 'native-parent', inheritedProviderSessionId: 'native-child' })

    await replaceChild(h.hook)

    const successor = h.writer.getState().sessions.successor!
    expect(successor).toMatchObject({
      inheritedParentContext: true,
      inheritedParentProviderSessionId: 'native-parent',
      inheritedProviderSessionId: 'native-child',
    })
    const output = readOrchestrationAgent({
      state: h.writer.getState(),
      runtimes: { successor: { ...emptyRuntime(), entries: [
        assistantEntry('PARENT: the reviewer should look at the lease counting'),
        userEntry(buildOrchestrationBootstrapPrompt({ task: 'review the lease facade' })),
        assistantEntry('CHILD: the facade drops the last lease before the read finishes'),
      ] } },
      parentSessionId: 'parent' as never,
      sessionId: 'successor',
    } as never)
    const texts = output.messages.map(message => message.text).join('\n')
    expect(texts).toContain('CHILD: the facade drops the last lease')
    expect(texts).not.toContain('PARENT: the reviewer should look at')
  })

  it('does not resurrect a pointer whose target is gone', async () => {
    // The carry hands the successor the PREDECESSOR's pointers, and the
    // predecessor may have outlived its parent (a closed parent leaves its
    // children behind as top-level rows). The two halves have to compose:
    // `remapSessionsRelationships`, which runs over the whole record right
    // after this literal, is what drops a pointer whose target survived under
    // neither a new nor an old id. If the carry were applied after it — or
    // the remap were narrowed to "other sessions" — a reload would quietly
    // re-file the pane under a parent that no longer exists, and every
    // parent-scoped read would throw instead of returning an orphan.
    const h = setup({ ...CHILD, orchestrationParentId: 'ghost' as never, orchestrationRootId: 'ghost' as never, linkedParentId: 'ghost' as never })

    await replaceChild(h.hook)

    const successor = h.writer.getState().sessions.successor!
    expect(successor).not.toHaveProperty('orchestrationParentId')
    expect(successor).not.toHaveProperty('linkedParentId')
    // The run and role are not ids and have no target to outlive, so they
    // stay: an orphaned worker is still a worker of run r1.
    expect(successor.orchestrationRunId).toBe('r1')
  })

  it('does NOT carry them when an unrelated conversation is swapped into the pane', async () => {
    // `replaceSession` is not only reload / switch / resume / rewind: the
    // Conversations picker uses it to pull some past conversation into the
    // pane the user is looking at. Inheriting parentage there files a stranger
    // as somebody's orchestration child — `wait_agents` polls its activity,
    // `read_agent` reports its last message as the child's answer to a task it
    // never saw, `close_run` kills the user's resumed conversation, and the
    // bootstrap flag claims a brief it never received.
    //
    // Only the caller can tell the two apart, which is why this is an option
    // and not a test of some inference inside the callee.
    const h = setup()

    await act(async () => {
      await h.hook.result.current.replaceSession('/project', {
        kind: 'codex', targetSessionId: 'child' as never, resumeSessionId: 'a-strangers-conversation', newConversation: true,
      })
      await vi.runAllTimersAsync()
    })

    const successor = h.writer.getState().sessions.successor!
    expect(successor).not.toHaveProperty('orchestrationParentId')
    expect(successor).not.toHaveProperty('orchestrationRunId')
    expect(successor).not.toHaveProperty('orchestrationBootstrapPromptDelivered')
    expect(successor).not.toHaveProperty('linkedParentId')
    // And the parent stops seeing it, which is the point: it is not that
    // parent's worker any more.
    const listed = listOrchestrationAgents({
      state: h.writer.getState(), runtimes: {}, parentSessionId: 'parent' as never, runId: 'r1',
    } as never)
    expect(listed).toEqual([])
  })

  it('keeps the view mode the user pinned to this pane', async () => {
    // Not a relationship, and found in the same literal during review (#1090):
    // `agentViewModeOverride` is the user saying "show THIS pane as a terminal
    // (or as an agent) whatever the global default is". Undo-close carries it;
    // replacement dropped it, so every reload silently reverted the choice and
    // the pane the user had pinned came back as something else.
    const h = setup({ ...CHILD, agentViewModeOverride: 'terminal' as never })

    await replaceChild(h.hook)

    expect(h.writer.getState().sessions.successor?.agentViewModeOverride).toBe('terminal')
  })

  it('keeps the browser pocket with its pocketId, so the page and its login survive the id swap', async () => {
    // Reload / provider switch / rewind mint a NEW SessionId. The pocket's
    // cookie partition and live guest are keyed by pocketId; losing the field
    // here would drop the pocket and log the user out of their dev app.
    const pocket = { pocketId: 'p-1', url: 'http://localhost:5173/', view: 'open', split: 0.4, profile: 'lane' } as const
    const h = setup({ ...CHILD, browserPocket: pocket as never })

    await replaceChild(h.hook)

    expect(h.writer.getState().sessions.successor?.browserPocket).toEqual(pocket)
  })

  it('carries nothing when the predecessor had no relationships', async () => {
    // The control: "always set the fields" would satisfy the four above and
    // make every reloaded pane look like somebody's orchestration child.
    const h = setup({})

    await replaceChild(h.hook)

    const successor = h.writer.getState().sessions.successor!
    expect(successor).not.toHaveProperty('orchestrationParentId')
    expect(successor).not.toHaveProperty('orchestrationRunId')
    expect(successor).not.toHaveProperty('linkedParentId')
    expect(successor).not.toHaveProperty('orchestrationBootstrapPromptDelivered')
    expect(successor).not.toHaveProperty('inheritedParentContext')
  })
})
