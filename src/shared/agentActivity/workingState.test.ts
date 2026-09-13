import { describe, expect, it } from 'vitest'

import { INITIAL_WORKING_STATE, isWorking, reduceWorkingState } from '@shared/agentActivity/workingState'
import type { WorkingSignal, WorkingState } from '@shared/agentActivity/workingState'

// The rules the Claude/Codex equivalence test cannot reach: providers without
// stream phases (OpenCode), the user-attention pause and the session ending.

const semantic = (event: Record<string, unknown>): WorkingSignal => ({ type: 'semantic', event })

function run(signals: WorkingSignal[]): { state: WorkingState; working: boolean[] } {
  let state = INITIAL_WORKING_STATE
  const working: boolean[] = []
  for (const signal of signals) {
    state = reduceWorkingState(state, signal)
    working.push(isWorking(state))
  }
  return { state, working }
}

describe('reduceWorkingState', () => {
  it('works from turn start to turn end for a provider that publishes turns but no phases', () => {
    expect(run([
      semantic({ type: 'turn_started' }),
      semantic({ type: 'text_delta' }),
      semantic({ type: 'turn_completed' }),
    ]).working).toEqual([true, true, false])
  })

  it('lets stream phases own the answer once any was seen', () => {
    // A phase-driven session that is idle does not start working on turn_started.
    expect(run([
      semantic({ type: 'stream_phase', phase: 'idle' }),
      semantic({ type: 'turn_started' }),
    ]).working).toEqual([false, false])
  })

  it('keeps working through a pending tool, and a matching tool result lets the turn end', () => {
    expect(run([
      semantic({ type: 'stream_phase', phase: 'awaiting-tool', toolUseId: 'tool-1' }),
      semantic({ type: 'turn_completed' }),
      semantic({ type: 'tool_result', toolUseId: 'other' }),
      semantic({ type: 'turn_completed' }),
      semantic({ type: 'tool_result', toolUseId: 'tool-1' }),
      semantic({ type: 'turn_completed' }),
    ]).working).toEqual([true, true, true, true, true, false])
  })

  it('does not end a turn that still owes a tool its result, until the result arrives or a new turn replaces it', () => {
    expect(run([
      semantic({ type: 'turn_started', turnId: 'turn-1' }),
      semantic({ type: 'stream_phase', phase: 'tool-input' }),
      semantic({ type: 'block_started', kind: 'function_call', callId: 'call-1' }),
      semantic({ type: 'turn_completed' }),
      semantic({ type: 'tool_completed', callId: 'call-1' }),
      semantic({ type: 'turn_completed' }),
    ]).working).toEqual([true, true, true, true, true, false])

    const replaced = run([
      semantic({ type: 'stream_phase', phase: 'responding' }),
      semantic({ type: 'turn_started', turnId: 'turn-1' }),
      semantic({ type: 'block_started', kind: 'tool_use', toolUseId: 'toolu-1' }),
      semantic({ type: 'turn_started', turnId: 'turn-2' }),
      semantic({ type: 'turn_completed' }),
    ])
    expect(replaced.working.at(-1)).toBe(false)
  })

  it('pauses while blocked on the user and resumes when the prompt is answered', () => {
    expect(run([
      semantic({ type: 'stream_phase', phase: 'responding' }),
      { type: 'attention', blocked: true },
      { type: 'attention', blocked: false },
    ]).working).toEqual([true, false, true])
  })

  it('stops for good when the session ends', () => {
    const { working, state } = run([
      semantic({ type: 'stream_phase', phase: 'responding' }),
      { type: 'ended' },
      semantic({ type: 'stream_phase', phase: 'thinking' }),
    ])
    expect(working).toEqual([true, false, false])
    expect(state.ended).toBe(true)
  })

  it('returns the same state object when nothing changed', () => {
    const state = reduceWorkingState(INITIAL_WORKING_STATE, semantic({ type: 'stream_phase', phase: 'thinking' }))
    expect(reduceWorkingState(state, semantic({ type: 'stream_phase', phase: 'thinking' }))).toBe(state)
    expect(reduceWorkingState(state, semantic({ type: 'text_delta' }))).toBe(state)
  })
})
