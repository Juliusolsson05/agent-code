import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_WORKING_STATE, isWorking, reduceWorkingState } from '@shared/agentActivity/workingState'
import type { WorkingState } from '@shared/agentActivity/workingState'
import {
  chunk,
  completed,
  created,
  functionCall,
  messageEnd,
  messageStart,
  mountClaudePane,
  mountCodexPane,
  reasoningAdded,
  request,
  responseEnd,
  thinkingDelta,
  thinkingStart,
} from '@renderer/session-runtime/semantic/testing/proxyPaneDrivers'
import type { Frame, Pane } from '@renderer/session-runtime/semantic/testing/proxyPaneDrivers'

// Agent Analytics records working time in MAIN (#964), but the number the user
// already trusts is the in-feed counter, painted from the RENDERER's stream-phase
// machine. Main cannot import that machine (renderer code, and it consults the
// renderer-only semantic fold), so shared/agentActivity/workingState.ts restates
// its rules. This file is what keeps the restatement honest: it drives the REAL
// Claude and Codex proxy adapters and, after EVERY semantic event, requires main's
// "working" to equal the counter's "not idle". Equal per event means equal
// intervals, because both sides stamp the same clock at the same event.
//
// If this fails after an adapter or phase-machine change, fix workingState.ts to
// match the counter — the counter is the user-visible truth.

type Step = { event: string; counter: boolean; recorder: boolean }

function sideBySide() {
  let main: WorkingState = INITIAL_WORKING_STATE
  const steps: Step[] = []
  return {
    onEvent(ev: Record<string, unknown>, pane: Pane): void {
      main = reduceWorkingState(main, { type: 'semantic', event: ev })
      steps.push({
        // The event label makes a failure name the event the two sides split on.
        event: ev.type === 'stream_phase' ? `stream_phase:${String(ev.phase)}` : String(ev.type),
        counter: pane.phase.streamPhase !== 'idle',
        recorder: isWorking(main),
      })
    },
    steps,
  }
}

function expectSameWorkingPeriods(trace: ReturnType<typeof sideBySide>, workingAtEnd: boolean): void {
  // Guard against a vacuous pass: the traffic must actually have made the pane work.
  expect(trace.steps.some(step => step.counter)).toBe(true)
  const split = trace.steps.findIndex(step => step.recorder !== step.counter)
  // On failure, print the event path up to the split as event(counter recorder),
  // W = working, - = idle.
  const path = trace.steps
    .slice(0, split + 1)
    .map(step => `${step.event}(${step.counter ? 'W' : '-'}${step.recorder ? 'W' : '-'})`)
    .join(' → ')
  expect(split, path).toBe(-1)
  expect(trace.steps.at(-1)?.counter).toBe(workingAtEnd)
}

const T0 = Date.parse('2026-09-10T09:00:00Z')
const MINUTE = 60_000

const toolUseMessage = (id: string, toolUseId: string): Frame[] => [
  messageStart(id),
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'Bash', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"synthetic"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('main working state matches the in-feed counter (Claude proxy)', () => {
  it('a thinking turn that finishes', () => {
    const trace = sideBySide()
    const pane = mountClaudePane(trace.onEvent)
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, [messageStart('msg_1'), thinkingStart(0), thinkingDelta(0)])
    vi.setSystemTime(T0 + MINUTE)
    chunk(pane.adapter, 1, messageEnd())
    responseEnd(pane.adapter, 1)
    expectSameWorkingPeriods(trace, false)
  })

  it('a tool call, the tool running between requests, and the follow-up request', () => {
    const trace = sideBySide()
    const pane = mountClaudePane(trace.onEvent)
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, toolUseMessage('msg_tool', 'toolu_1'))
    responseEnd(pane.adapter, 1)
    vi.setSystemTime(T0 + 5 * MINUTE)
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_after_tool'), thinkingStart(0), thinkingDelta(0)])
    chunk(pane.adapter, 2, messageEnd())
    responseEnd(pane.adapter, 2)
    expectSameWorkingPeriods(trace, false)
  })

  it('a stream severed by sleep and sealed after wake', () => {
    const trace = sideBySide()
    const pane = mountClaudePane(trace.onEvent)
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, [messageStart('msg_1'), thinkingStart(0), thinkingDelta(0)])
    vi.setSystemTime(T0 + 8 * 60 * MINUTE)
    pane.adapter.sealFlowsSilentSince(T0 + MINUTE, 'system-suspended')
    expectSameWorkingPeriods(trace, false)
  })

  it('a severed stream reaped by a retry after wake', () => {
    const trace = sideBySide()
    const pane = mountClaudePane(trace.onEvent)
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, [messageStart('msg_1'), thinkingStart(0), thinkingDelta(0)])
    vi.setSystemTime(T0 + 8 * 60 * MINUTE)
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_retry'), thinkingStart(0)])
    expectSameWorkingPeriods(trace, true)
  })
})

describe('main working state matches the in-feed counter (Codex proxy)', () => {
  it('a reasoning turn that completes', () => {
    const trace = sideBySide()
    const pane = mountCodexPane(trace.onEvent)
    pane.request('req-1')
    pane.frames('req-1', [created('resp_1'), reasoningAdded(0)])
    vi.setSystemTime(T0 + MINUTE)
    pane.frames('req-1', [completed('resp_1')])
    pane.end('req-1')
    expectSameWorkingPeriods(trace, false)
  })

  it('a client tool call, the tool running, and the follow-up request', () => {
    const trace = sideBySide()
    const pane = mountCodexPane(trace.onEvent)
    pane.request('req-1')
    pane.frames('req-1', [created('resp_tool'), ...functionCall(0), completed('resp_tool')])
    pane.end('req-1')
    vi.setSystemTime(T0 + 5 * MINUTE)
    pane.request('req-2')
    pane.frames('req-2', [created('resp_after_tool'), reasoningAdded(0), completed('resp_after_tool')])
    pane.end('req-2')
    expectSameWorkingPeriods(trace, false)
  })

  it('a tool call still streaming when the lid closed, sealed after wake', () => {
    const trace = sideBySide()
    const pane = mountCodexPane(trace.onEvent)
    pane.request('req-1')
    pane.frames('req-1', [
      created('resp_tool_streaming'),
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'exec_command', status: 'in_progress' } },
    ])
    vi.setSystemTime(T0 + 8 * 60 * MINUTE)
    pane.adapter.sealFlowsSilentSince(T0 + MINUTE, 'system-suspended')
    expectSameWorkingPeriods(trace, false)
  })

  it('a client tool that has not returned yet is still working', () => {
    const trace = sideBySide()
    const pane = mountCodexPane(trace.onEvent)
    pane.request('req-1')
    pane.frames('req-1', [created('resp_tool'), ...functionCall(0), completed('resp_tool')])
    pane.end('req-1')
    expectSameWorkingPeriods(trace, true)
  })
})
