import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { sessionActivity } from '@renderer/session-runtime/activity'
import { tldrActivity } from '@renderer/features/tldr/freshness'
import { listManagedAgentDescriptors, readManagedAgentOutput, readManagedAgentOutputs } from '@renderer/workspace/agentManagementMcp'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// #915. Two surfaces answered "when was this agent last active" from the same
// runtime fields with different rules:
//
//   - the TLDR peek footer took max(lastJsonlEntryAt, phaseChangedAt,
//     turnStartedAt, submittedAt), with a transcript-tail fallback that
//     accepted ANY entry;
//   - the agent_management inventory's runtimeActivityAt had no watermark at
//     all, and its separate transcriptActivityAt used a tail fallback that
//     accepted only user/assistant entries carrying non-empty TEXT. The
//     main-process bridge recombined them, so the watermark reached the answer
//     only when the transcript file's mtime happened to be missing.
//
// They diverge when the newest entry carries no visible text and the ingest
// watermark is null. The entry shapes below are the two real ones: an
// `assistant` row whose content is a single `tool_use` block, and a `user` row
// whose content is a single `tool_result` block. Over 500 local Claude
// transcripts the newest conversation entry carries no visible text in 24 —
// 20 of them the `tool_result` shape, 4 the `tool_use` shape. (Both were
// hand-shaped and wrong in the first version of this file: `{type:'tool_use'}`
// is not an entry type, and a `user` entry with a bare `text` property has no
// text as far as `entryTextContent` is concerned, so the test passed without
// reproducing anything. Review of #1080 caught it.)
// ---------------------------------------------------------------------------

const TURN_AT = '2026-09-20T09:00:00.000Z'
const TOOL_AT = '2026-09-20T09:05:00.000Z'

/** A `user` turn as Claude writes it: content is an array of blocks. */
const userTurn = (timestamp: string) => ({
  type: 'user',
  timestamp,
  uuid: 'u1',
  message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
})

/** An `assistant` row holding only a tool call — no text block anywhere. */
const assistantToolUse = (timestamp: string) => ({
  type: 'assistant',
  timestamp,
  uuid: 'a1',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
  },
})

/** A `user` row holding only a tool result — the MORE COMMON divergent tail. */
const userToolResult = (timestamp: string) => ({
  type: 'user',
  timestamp,
  uuid: 'u2',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }],
  },
})

function runtimeWithTail(tail: Record<string, unknown>): SessionRuntime {
  const runtime = emptyRuntime()
  runtime.entries = [userTurn(TURN_AT), tail] as unknown as SessionRuntime['entries']
  // The ingest watermark is absent, which is the precondition: with it set,
  // both rules would agree by accident. `history.renderer.test.tsx` proves
  // this state is reachable rather than merely constructible.
  runtime.lastJsonlEntryAt = null
  return runtime
}

function stateFixture(): WorkspaceState {
  return {
    tabs: [{ id: 'project-a', title: 'Project A' }],
    activeTabId: 'project-a',
    stage: oneLaneStage('caller'),
    sessions: {
      caller: { cwd: '/repo', kind: 'claude', providerSessionId: 'p-caller', projectId: 'project-a', joinedAt: 0 },
      worker: { cwd: '/repo', kind: 'claude', providerSessionId: 'p-worker', projectId: 'project-a', joinedAt: 1 },
    },
    pinnedSessionIds: [],
  } as unknown as WorkspaceState
}

const listParams = (runtime: SessionRuntime) => ({
  state: stateFixture(),
  callerSessionId: 'caller',
  runtimes: { worker: runtime } as Record<string, SessionRuntime>,
})

function workerDescriptor(runtime: SessionRuntime) {
  const { agents } = listManagedAgentDescriptors(listParams(runtime) as never)
  const worker = agents.find(item => item.agent.sessionId === 'worker')
  if (!worker) throw new Error('the worker descriptor is missing')
  return worker
}

describe('the footer and the inventory agree on last-active (#915)', () => {
  it.each([
    { shape: 'an assistant row holding only a tool_use', tail: assistantToolUse(TOOL_AT) },
    { shape: 'a user row holding only a tool_result', tail: userToolResult(TOOL_AT) },
  ])('both count $shape as activity', ({ tail }) => {
    // THE DIVERGENCE. The footer reported this entry's time; the inventory's
    // tail rule skipped it, because it required a non-empty TEXT block, and
    // reported the older turn instead.
    const runtime = runtimeWithTail(tail)
    expect(tldrActivity(runtime).timestamp).toBe(Date.parse(TOOL_AT))
    expect(workerDescriptor(runtime).lastActiveAt).toBe(Date.parse(TOOL_AT))
    // Stated separately because "they are equal" would also hold if BOTH
    // regressed to the older turn.
    expect(workerDescriptor(runtime).lastActiveAt).not.toBe(Date.parse(TURN_AT))
  })

  it('agrees on the ingest watermark, which the inventory reached only when the mtime was missing', () => {
    const runtime = emptyRuntime()
    runtime.lastJsonlEntryAt = Date.parse(TOOL_AT)
    runtime.turnStartedAt = Date.parse(TURN_AT)
    expect(tldrActivity(runtime).timestamp).toBe(Date.parse(TOOL_AT))
    expect(workerDescriptor(runtime).lastActiveAt).toBe(Date.parse(TOOL_AT))
  })

  it('agrees that a runtime with no evidence has no answer', () => {
    const runtime = emptyRuntime()
    expect(tldrActivity(runtime).timestamp).toBeNull()
    expect(workerDescriptor(runtime).lastActiveAt).toBeUndefined()
    expect(workerDescriptor(runtime).lastActiveSource).toBeUndefined()
  })

  it('is literally the same function, so it cannot drift again', () => {
    // The two surfaces converging today is worth less than their being unable
    // to diverge tomorrow.
    expect(tldrActivity).toBe(sessionActivity)
  })
})

describe('every runtime clock is evidence (#915)', () => {
  // The rule's own WHY calls phase timestamps "observed work". Each of the
  // three has to be able to WIN on its own, or it is decoration: a mutation
  // dropping turnStartedAt or submittedAt from the evidence used to leave the
  // whole suite green.
  it.each(['phaseChangedAt', 'turnStartedAt', 'submittedAt'] as const)('%s alone decides the answer', field => {
    const runtime = emptyRuntime()
    runtime[field] = Date.parse(TOOL_AT)
    expect(sessionActivity(runtime).timestamp).toBe(Date.parse(TOOL_AT))
    expect(sessionActivity(runtime).source).toBe('runtime')
    expect(workerDescriptor(runtime).lastActiveAt).toBe(Date.parse(TOOL_AT))
  })

  it.each(['phaseChangedAt', 'turnStartedAt', 'submittedAt'] as const)('%s wins when it is the newest', field => {
    const runtime = emptyRuntime()
    runtime.phaseChangedAt = Date.parse(TURN_AT)
    runtime.turnStartedAt = Date.parse(TURN_AT)
    runtime.submittedAt = Date.parse(TURN_AT)
    runtime[field] = Date.parse(TOOL_AT)
    expect(sessionActivity(runtime).timestamp).toBe(Date.parse(TOOL_AT))
  })
})

describe('the source label is the evidence it cites (#915)', () => {
  // `lastActivitySource` is cited by an auditing agent, and the design doc
  // ranks a real transcript record above a clock a screen repaint can move.
  // The bridge used to label the renderer's answer 'runtime' whatever it
  // rested on, so a JSONL watermark was published as a weaker citation than it
  // deserved.
  it('says transcript when the ingest watermark wins', () => {
    const runtime = emptyRuntime()
    runtime.lastJsonlEntryAt = Date.parse(TOOL_AT)
    runtime.turnStartedAt = Date.parse(TURN_AT)
    expect(workerDescriptor(runtime).lastActiveSource).toBe('transcript')
  })

  it('says transcript when the transcript TAIL wins with no watermark', () => {
    expect(workerDescriptor(runtimeWithTail(assistantToolUse(TOOL_AT))).lastActiveSource).toBe('transcript')
  })

  it('says runtime when only a clock has anything to say', () => {
    const runtime = emptyRuntime()
    runtime.phaseChangedAt = Date.parse(TOOL_AT)
    expect(workerDescriptor(runtime).lastActiveSource).toBe('runtime')
  })

  it('gives a tie to the transcript, the stronger evidence', () => {
    const runtime = emptyRuntime()
    runtime.lastJsonlEntryAt = Date.parse(TOOL_AT)
    runtime.phaseChangedAt = Date.parse(TOOL_AT)
    expect(sessionActivity(runtime).source).toBe('transcript')
  })
})

describe('the answer survives every hop to the bridge (#915)', () => {
  // The bridge is one process away and cannot tell a dropped field from an
  // agent that has no activity: it just falls back to a weaker candidate and
  // still publishes A number. Each forwarding site therefore needs its own
  // assertion — dropping either of the two read paths used to leave the whole
  // suite green.
  const runtime = () => {
    const value = emptyRuntime()
    value.lastJsonlEntryAt = Date.parse(TOOL_AT)
    return value
  }

  it('single read carries it', () => {
    const result = readManagedAgentOutput({ ...listParams(runtime()), sessionId: 'worker' } as never)
    expect(result).toMatchObject({ lastActiveAt: Date.parse(TOOL_AT), lastActiveSource: 'transcript' })
  })

  it('bulk read carries it', () => {
    const result = readManagedAgentOutputs({ ...listParams(runtime()), sessionIds: ['worker'] } as never)
    expect(result.agents.find(item => item.agent.sessionId === 'worker'))
      .toMatchObject({ lastActiveAt: Date.parse(TOOL_AT), lastActiveSource: 'transcript' })
  })
})
