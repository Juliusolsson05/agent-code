import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { sessionActivity } from '@renderer/session-runtime/activity'
import { tldrActivity } from '@renderer/features/tldr/freshness'
import { listManagedAgentDescriptors } from '@renderer/workspace/agentManagementMcp'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// #915. Two surfaces answered "when was this agent last active" from the same
// runtime fields with different rules:
//
//   - the TLDR peek footer took max(lastJsonlEntryAt, phaseChangedAt,
//     turnStartedAt, submittedAt), with a transcript-tail fallback that
//     accepted ANY entry;
//   - the agent_management MCP inventory left lastJsonlEntryAt out entirely,
//     and its tail fallback accepted only user/assistant entries with
//     non-empty text.
//
// They diverge exactly when the newest entry is a tool or system record and
// the ingest watermark is null. Cosmetic in the UI — but the inventory is what
// an ORCHESTRATING AGENT reads to decide whether a child is idle, so two
// answers to "when was this last active" is two answers to "is this safe to
// close".
// ---------------------------------------------------------------------------

const TURN_AT = '2026-09-20T09:00:00.000Z'
const TOOL_AT = '2026-09-20T09:05:00.000Z'

/** A runtime whose NEWEST entry is a tool record — the divergent shape. */
function toolTailRuntime(): SessionRuntime {
  const runtime = emptyRuntime()
  runtime.entries = [
    { type: 'user', timestamp: TURN_AT, text: 'do the thing' },
    { type: 'tool_use', timestamp: TOOL_AT, name: 'Bash' },
  ] as unknown as SessionRuntime['entries']
  // The ingest watermark is absent, which is the precondition: with it set,
  // both rules would agree by accident.
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

function workerDescriptor(runtime: SessionRuntime) {
  const { agents } = listManagedAgentDescriptors({
    state: stateFixture(),
    callerSessionId: 'caller',
    runtimes: { worker: runtime } as Record<string, SessionRuntime>,
  } as never)
  const worker = agents.find(item => item.agent.sessionId === 'worker')
  if (!worker) throw new Error('the worker descriptor is missing')
  return worker
}

describe('the footer and the inventory agree on last-active (#915)', () => {
  it('both count a tool record as activity', () => {
    // THE DIVERGENCE. The footer reported the tool record's time; the
    // inventory skipped it and reported the older turn, or nothing.
    const runtime = toolTailRuntime()
    expect(tldrActivity(runtime).timestamp).toBe(Date.parse(TOOL_AT))
    expect(workerDescriptor(runtime).lastActiveAt).toBe(Date.parse(TOOL_AT))
  })

  it('the inventory no longer reports the older turn for that runtime', () => {
    // Stated as its own assertion because "they are equal" would also hold if
    // BOTH regressed to the older turn.
    const runtime = toolTailRuntime()
    expect(workerDescriptor(runtime).lastActiveAt).not.toBe(Date.parse(TURN_AT))
  })

  it('agrees on the ingest watermark, which the inventory ignored entirely', () => {
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
  })

  it('is literally the same function, so it cannot drift again', () => {
    // The two surfaces converging today is worth less than their being unable
    // to diverge tomorrow.
    expect(tldrActivity).toBe(sessionActivity)
  })
})

describe('the raw evidence is still published', () => {
  it('keeps both inputs beside the unified answer', () => {
    // Kept for existing callers, and documented as inputs rather than
    // answers — recombining them is how the divergence happened.
    const runtime = emptyRuntime()
    runtime.lastJsonlEntryAt = Date.parse(TOOL_AT)
    runtime.turnStartedAt = Date.parse(TURN_AT)
    const descriptor = workerDescriptor(runtime)
    expect(descriptor.transcriptActivityAt).toBe(Date.parse(TOOL_AT))
    expect(descriptor.runtimeActivityAt).toBe(Date.parse(TURN_AT))
  })
})
