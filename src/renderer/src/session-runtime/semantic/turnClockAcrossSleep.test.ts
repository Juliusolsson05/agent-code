import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workingSeconds } from '@shared/agentActivity/workingSeconds'
import type { SystemSuspension } from '@shared/types/systemSuspension'
import type { StreamPhaseState } from '@renderer/session-runtime/semantic/streamPhaseMachine'
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
import type { Pane } from '@renderer/session-runtime/semantic/testing/proxyPaneDrivers'
import { submitJoinsLiveWork } from '@renderer/workspace/hook/actions/streaming'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'
import { emptyRuntime } from '@renderer/session-runtime/state'

// The in-feed turn clock across a laptop sleep (#963).
//
// HISTORY: this file first REPRODUCED the bug against today's code (commit
// a42ee7ee): a Claude stream severed by sleep stayed `Thinking` forever on its
// pre-sleep clock (reading `20h03m` the next morning), a Codex tool that never
// returned stayed `awaiting-tool`, and any turn that carried on after wake counted
// the whole night. Stage 3 of docs/decomposition/agent-working-time.md inverted
// those rows to the behaviour the user decided (§6 Q1a, Q2a) BEFORE the fix was
// written. Rows that were already correct (retry after wake, turn finished before
// sleep) are unchanged.
//
// It drives the REAL Claude and Codex proxy adapters and the REAL renderer
// reducers in the order the desktop hook runs them (useIpcSubscriptions' semantic
// handler: foldSemanticEvent, then reduceStreamPhase on the post-fold turn), with
// only the wall clock simulated.
//
// Timings come from a real recording (decomposition §2.4, case A):
//   - Claude transcript bringdown/a531e423…jsonl: prompt 2026-08-31 20:57:09 PDT,
//     last assistant entry 22:45:08, next entries after 09-01 08:01:57.
//   - /var/log/powermanagement: clamshell sleep 23:43:59 → wake 08:01:40.
//   - Claude's own `turn_duration` for that turn: 39,888,429 ms (11.08 h).
// Frame CONTENT is synthetic; only the shapes and times are from the recording.
//
// What "sleep" means for the proxy path: the TCP connection to the API dies while
// the lid is closed, so the proxy never forwards `response-end` for that flow.
// The provider runtime is told about the suspension (SystemSuspensionTracker →
// SessionManager.noteSystemSuspension) and asks its adapter to seal flows that
// have been silent since the sleep began: Claude after a grace period that lets
// Claude Code retry, Codex immediately.

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const PROMPT_AT = PDT('2026-08-31T20:57:09')
const LAST_STREAM_AT = PDT('2026-08-31T22:45:08')
const SLEEP_AT = PDT('2026-08-31T23:43:59')
const WAKE_AT = PDT('2026-09-01T08:01:40')
const SLEEP: SystemSuspension = { suspendedAt: SLEEP_AT, resumedAt: WAKE_AT, source: 'power-monitor' }
const CLAUDE_SEAL_GRACE_MS = 60_000

/** What WorkIndicator paints after its phase label, in seconds: working time
 *  that excludes the machine's suspensions. */
function shownSeconds(phase: StreamPhaseState, suspensions: SystemSuspension[] = [SLEEP]): number | null {
  if (phase.streamPhase === 'idle') return null
  return workingSeconds(phase.turnStartedAt, suspensions, Date.now())
}

/** The feed item types the REAL pipeline paints for this pane: the ledger input
 *  adapter, the ownership ledger and the view bridge Feed renders from — the
 *  same chain the control-read projection uses, so no feed logic is re-modelled
 *  here. */
function feedItemTypes(pane: Pane, provider: 'claude' | 'codex'): string[] {
  const runtime = {
    ...emptyRuntime(),
    semantic: pane.semantic,
    streamPhase: pane.phase.streamPhase,
    streamPhasePendingToolName: pane.phase.streamPhasePendingToolName,
    streamPhasePendingToolUseId: pane.phase.streamPhasePendingToolUseId,
  }
  const ledger = createSessionLedger()(createLedgerInputAdapter()({
    provider,
    sessionId: 'pane',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }).input)
  return ledgerToFeedItems(ledger, providerLedgerFeedContextFromRuntime(runtime, provider).context)
    .items.map(item => item.type)
}

/** A Claude turn that was streaming thinking right up to the moment the lid closed. */
function streamUntilSleep(pane: ReturnType<typeof mountClaudePane>): void {
  vi.setSystemTime(PROMPT_AT)
  request(pane.adapter, 1)
  chunk(pane.adapter, 1, [messageStart('msg_before_sleep'), thinkingStart(0), thinkingDelta(0)])
  vi.setSystemTime(LAST_STREAM_AT)
  chunk(pane.adapter, 1, [thinkingDelta(0)])
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('in-feed turn clock across a laptop sleep (Claude proxy)', () => {
  it('stamps the clock when the turn starts, and it is Thinking before the lid closes', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
    expect(pane.reducer.pane.phase.turnStartedAt).toBe(PROMPT_AT)
  })

  it('never counts the sleep, and seals a severed stream as interrupted by sleep once the grace period passes', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    // Wake. Inside the grace period the turn may still be retried, so it stays
    // Thinking — but the counter shows working time without the night.
    vi.setSystemTime(WAKE_AT)
    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
    expect(shownSeconds(pane.reducer.pane.phase)).toBe((SLEEP_AT - PROMPT_AT) / 1000)

    // No retry and no sign of life: the runtime asks the adapter to seal every
    // flow silent since the sleep began.
    vi.setSystemTime(WAKE_AT + CLAUDE_SEAL_GRACE_MS)
    pane.adapter.sealFlowsSilentSince(SLEEP.suspendedAt, 'system-suspended')

    expect(pane.reducer.stops).toEqual([expect.objectContaining({ interruption: 'system-suspended' })])
    expect(pane.reducer.pane.phase.streamPhase).toBe('idle')
    expect(shownSeconds(pane.reducer.pane.phase)).toBeNull()
    // A prompt sent now starts its own turn and clock.
    expect(submitJoinsLiveWork({
      semantic: pane.reducer.pane.semantic,
      streamPhase: pane.reducer.pane.phase.streamPhase,
    })).toBe(false)
  })

  it('leaves an "Interrupted while asleep" marker as the feed tail until the next prompt makes the pane work again', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)
    expect(feedItemTypes(pane.reducer.pane, 'claude')).toContain('work')

    vi.setSystemTime(WAKE_AT + CLAUDE_SEAL_GRACE_MS)
    pane.adapter.sealFlowsSilentSince(SLEEP.suspendedAt, 'system-suspended')
    const sealed = feedItemTypes(pane.reducer.pane, 'claude')
    expect(sealed).not.toContain('work')
    expect(sealed.at(-1)).toBe('sleep-interruption')

    // The next prompt streams: the marker gives way to the work chip.
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_next_prompt'), thinkingStart(0)])
    const working = feedItemTypes(pane.reducer.pane, 'claude')
    expect(working).not.toContain('sleep-interruption')
    expect(working).toContain('work')
  })

  it('does not seal a stream that showed life after the sleep began', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    vi.setSystemTime(WAKE_AT)
    chunk(pane.adapter, 1, [thinkingDelta(0)])
    vi.setSystemTime(WAKE_AT + CLAUDE_SEAL_GRACE_MS)
    pane.adapter.sealFlowsSilentSince(SLEEP.suspendedAt, 'system-suspended')

    expect(pane.reducer.stops).toEqual([])
    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
  })

  it('a retry after wake reaps the severed stream and restarts the clock at the retry', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    vi.setSystemTime(WAKE_AT)
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_after_wake'), thinkingStart(0)])

    expect(pane.reducer.phases).toContain('idle')
    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
    expect(pane.reducer.pane.phase.turnStartedAt).toBe(WAKE_AT)
    expect(shownSeconds(pane.reducer.pane.phase)).toBe(0)
  })

  it('a turn that finished before the lid closed shows no counter after wake', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)
    chunk(pane.adapter, 1, messageEnd())
    responseEnd(pane.adapter, 1)

    vi.setSystemTime(WAKE_AT)
    expect(pane.reducer.pane.phase.streamPhase).toBe('idle')
    expect(shownSeconds(pane.reducer.pane.phase)).toBeNull()
    // A turn upstream finished is not "interrupted", however long the machine
    // slept afterwards: only an adapter seal may produce the marker.
    expect(feedItemTypes(pane.reducer.pane, 'claude')).not.toContain('sleep-interruption')
  })

  it('a tool that runs across the sleep and returns after wake shows working time without the sleep', () => {
    // The recorded case A shape: the turn carried on after wake and Claude wrote
    // an 11.08 h turn_duration. The turn is genuinely live; only the night is
    // removed from what the counter shows.
    const pane = mountClaudePane()
    vi.setSystemTime(PROMPT_AT)
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, [
      messageStart('msg_tool_call'),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"synthetic"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ])
    responseEnd(pane.adapter, 1)
    expect(pane.reducer.pane.phase.streamPhase).toBe('awaiting-tool')

    vi.setSystemTime(WAKE_AT)
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_after_tool'), thinkingStart(0)])

    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
    expect(pane.reducer.pane.phase.turnStartedAt).toBe(PROMPT_AT)
    expect(shownSeconds(pane.reducer.pane.phase)).toBe((SLEEP_AT - PROMPT_AT) / 1000)
  })
})

// ---------------------------------------------------------------------------
// Codex. Its adapter arms a watchdog interval (10 s tick, 60 s silence) that
// releases a silent active flow. Timers do not fire while the machine sleeps, so
// the first tick after wake is `advanceTimersByTime(10_000)` after the jump.
// ---------------------------------------------------------------------------

describe('in-feed turn clock across a laptop sleep (Codex proxy)', () => {
  it('a watchdog tick that arrives hours late defers instead of releasing, so the sleep seal can say why the turn stopped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Attach at the prompt time: the watchdog measures its own lateness from it.
    vi.setSystemTime(PROMPT_AT)
    const pane = mountCodexPane()
    pane.request('req-1')
    pane.frames('req-1', [created('resp_before_sleep'), reasoningAdded(0)])
    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')

    // Wake: the overdue watchdog tick fires first and must not release the flow
    // as an anonymous timeout — its own lateness shows the process was frozen.
    vi.setSystemTime(WAKE_AT)
    vi.advanceTimersByTime(10_000)
    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
    expect(shownSeconds(pane.reducer.pane.phase)).toBe((SLEEP_AT - PROMPT_AT) / 1000 + 10)

    // The suspension notice arrives and the runtime seals immediately.
    pane.adapter.sealFlowsSilentSince(SLEEP.suspendedAt, 'system-suspended')
    expect(pane.reducer.stops).toEqual([expect.objectContaining({ interruption: 'system-suspended' })])
    expect(pane.reducer.pane.phase.streamPhase).toBe('idle')
    expect(shownSeconds(pane.reducer.pane.phase)).toBeNull()
  })

  it('seals a tool call that was still streaming when the lid closed, although the turn has a pending tool', () => {
    // The `turn_completed` bridge refuses to idle a turn with pending tools, so
    // only the adapter's own `idle` can clear this pane. Without it the pane kept
    // `tool-input` on its pre-sleep clock.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.setSystemTime(PROMPT_AT)
    const pane = mountCodexPane()
    pane.request('req-1')
    pane.frames('req-1', [
      created('resp_tool_streaming'),
      { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'exec_command', status: 'in_progress' } },
    ])
    expect(pane.reducer.pane.phase.streamPhase).toBe('tool-input')

    vi.setSystemTime(WAKE_AT)
    pane.adapter.sealFlowsSilentSince(SLEEP.suspendedAt, 'system-suspended')

    expect(pane.reducer.stops).toEqual([expect.objectContaining({ interruption: 'system-suspended' })])
    expect(pane.reducer.pane.phase.streamPhase).toBe('idle')
  })

  it('without a suspension notice the watchdog still releases a silent flow on its next tick', () => {
    // A late tick with no sleep behind it (a stalled main process) must not leave
    // a dead stream held forever: the deferral is one tick, not a veto.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Attach at the prompt time: the watchdog measures its own lateness from it.
    vi.setSystemTime(PROMPT_AT)
    const pane = mountCodexPane()
    pane.request('req-1')
    pane.frames('req-1', [created('resp_stalled'), reasoningAdded(0)])

    vi.setSystemTime(WAKE_AT)
    vi.advanceTimersByTime(10_000)
    vi.advanceTimersByTime(10_000)
    expect(pane.reducer.pane.phase.streamPhase).toBe('idle')
  })

  it('a client tool that never returns stays awaiting the tool, with the sleep excluded from its clock', () => {
    // §6 Q1 applies to severed streams, not to a tool: the tool's process was
    // suspended too and usually completes after wake.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Attach at the prompt time: the watchdog measures its own lateness from it.
    vi.setSystemTime(PROMPT_AT)
    const pane = mountCodexPane()
    pane.request('req-1')
    pane.frames('req-1', [created('resp_tool'), ...functionCall(0), completed('resp_tool')])
    pane.end('req-1')
    expect(pane.reducer.pane.phase.streamPhase).toBe('awaiting-tool')

    vi.setSystemTime(WAKE_AT)
    pane.adapter.sealFlowsSilentSince(SLEEP.suspendedAt, 'system-suspended')
    vi.advanceTimersByTime(20_000)
    expect(pane.reducer.pane.phase.streamPhase).toBe('awaiting-tool')
    expect(pane.reducer.stops).toEqual([])
    expect(shownSeconds(pane.reducer.pane.phase)).toBe((SLEEP_AT - PROMPT_AT) / 1000 + 20)
  })

  it('a client tool that returns after wake continues the turn with working time excluding the sleep', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Attach at the prompt time: the watchdog measures its own lateness from it.
    vi.setSystemTime(PROMPT_AT)
    const pane = mountCodexPane()
    pane.request('req-1')
    pane.frames('req-1', [created('resp_tool'), ...functionCall(0), completed('resp_tool')])
    pane.end('req-1')

    vi.setSystemTime(WAKE_AT)
    pane.request('req-2')
    pane.frames('req-2', [created('resp_after_tool'), reasoningAdded(0)])

    expect(pane.reducer.pane.phase.streamPhase).toBe('thinking')
    expect(pane.reducer.pane.phase.turnStartedAt).toBe(PROMPT_AT)
    expect(shownSeconds(pane.reducer.pane.phase)).toBe((SLEEP_AT - PROMPT_AT) / 1000)
  })
})
