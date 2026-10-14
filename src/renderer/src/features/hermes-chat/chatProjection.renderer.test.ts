import { describe, expect, it, vi } from 'vitest'

import { ConversationReconciler, type CommittedRow, type SemanticEvent } from 'hermes-headless'
import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import type { SessionResumeResult, TranscriptMessage } from 'hermes-headless'
import { createHermesTranscriptEntryMapper } from '@providers/hermes/renderer/transcript/mapper'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'
import type { Entry } from '@shared/types/transcript'

import { groupActivity, projectChat, stabilizeChat, summarizeActivity, type ChatItem, type ChatRowItem, type ChatStep } from './chatProjection'

// ---------------------------------------------------------------------------
// The Hermes chat on the REAL pipeline, from a REAL recording (#1482).
//
// Fixture: hermes-headless research/corpus/S4, a turn with three tool calls
// (one failing) recorded against `hermes serve` v0.21.7. The live side is
// that recording's event stream folded by hermes-headless's reconciler into
// fold events, then by the production semantic reducer; the committed side is
// the same conversation's resume rows through the Hermes mapper. Both go
// through the adapter → ledger → provider bridge that useLedgerFeedItems runs
// (the Reader Mode test's pattern), then the chat projection.
//
// What this pins: the chat shows every unit ONCE whichever owner holds it,
// live, committed or both, because ownership is decided by the ledger and
// the projection only restyles it. A duplicate bubble or chip here is the
// bug class the decomposition isolated the ledger to prevent.
// ---------------------------------------------------------------------------

const T = 1_791_944_000_000

function s4() {
  const frames = inboundFrames(latestRecording('S4'))
  const created = frames.map((frame) => frame.result as Record<string, unknown> | undefined)
    .find((result) => result && typeof result.stored_session_id === 'string' && result.message_count === 0) as unknown as SessionResumeResult
  const sid = created.session_id
  const events = frames.filter((frame) => frame.method === 'event' && (frame.params as { session_id?: string }).session_id === sid)
    .map((frame) => frame.params as { type: string; session_id: string; payload?: unknown; seq?: number })
  const resumed = frames.map((frame) => frame.result as Record<string, unknown> | undefined)
    .filter((result) => Array.isArray(result?.messages) && (result!.messages as unknown[]).length > 0).at(-1) as unknown as SessionResumeResult
  return { created, events, resumed }
}

/** hermes-headless reconciler over recorded events → fold events. */
function liveEvents(created: SessionResumeResult, events: ReturnType<typeof s4>['events']): SemanticEvent[] {
  const out: SemanticEvent[] = []
  const reconciler = new ConversationReconciler({
    semantic: (event) => out.push(event),
    committed: () => undefined,
    historyReset: () => undefined,
    historyCaughtUp: () => undefined,
    activity: () => undefined,
    session: () => undefined,
    requestOpened: () => undefined,
    requestClosed: () => undefined,
    turnSettled: () => undefined,
    reclaimed: () => undefined,
    unknown: () => undefined, notice: () => undefined, noticeCleared: () => undefined, sideAnswer: () => undefined,
  })
  reconciler.applySnapshot(created, 'snapshot')
  for (const event of events) reconciler.applyEvent(event)
  return out
}

/** Committed rows through the Hermes mapper, keyed as hermes-headless keys them. */
function committedEntries(rows: TranscriptMessage[], stored: string): Entry[] {
  const mapper = createHermesTranscriptEntryMapper()
  return rows.flatMap((row, index) => {
    const key = typeof row.row_id === 'number' ? `row:${row.row_id}` : typeof row.tool_call_id === 'string' ? `tool:${row.tool_call_id}` : `idx:${index}`
    const payload: CommittedRow & { hermes: 1 } = { hermes: 1, key, storedSessionId: stored, row }
    return mapper.map(payload as unknown as Record<string, unknown>).entries
  })
}

function chat(entries: Entry[], semanticEvents: SemanticEvent[]): ChatItem[] {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(T)
  try {
    let runtime: SessionRuntime = { ...emptyRuntime(), entries }
    let semantic = runtime.semantic
    for (const event of semanticEvents) semantic = foldSemanticEvent(semantic, event, 'hermes')
    runtime = { ...runtime, semantic }
    const ledger = createSessionLedger()(createLedgerInputAdapter()({
      provider: 'hermes',
      sessionId: 'hermes-pane',
      entries: runtime.entries,
      semanticCurrent: runtime.semantic.currentTurn,
      semanticHistory: runtime.semantic.history,
      ghosts: runtime.ghosts,
      streamPhase: runtime.streamPhase,
      lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
    }).input)
    const { context } = providerLedgerFeedContextFromRuntime(runtime, 'hermes')
    return projectChat(ledgerToFeedItems(ledger, context).items)
  } finally {
    clock.mockRestore()
  }
}

const shape = (items: ChatItem[]) => items.filter((item) => item.kind !== 'empty' && item.kind !== 'typing').map((item) =>
  item.kind === 'tool' ? `tool:${item.toolUseId}:${item.status}` : item.kind === 'assistant' || item.kind === 'user' ? `${item.kind}:${item.text}` : item.kind)

describe('Hermes chat projection on the real pipeline (recorded S4)', () => {
  it('a live turn: three chips with Hermes\' call ids (the missing file one failed) and the answer once', () => {
    const { created, events } = s4()
    const items = chat([], liveEvents(created, events))
    expect(shape(items)).toEqual([
      'tool:call_tools_0_0:done',
      'tool:call_tools_0_1:error',
      'tool:call_tools_1_0:done',
      'assistant:All three tools ran.',
    ])
  })

  it('live turn PLUS its committed rows: every unit still appears exactly once', () => {
    const { created, events, resumed } = s4()
    const items = chat(committedEntries(resumed.messages, String(resumed.stored_session_id ?? '')), liveEvents(created, events))
    const tools = items.filter((item) => item.kind === 'tool').map((item) => (item as { toolUseId: string }).toolUseId)
    expect(new Set(tools).size).toBe(tools.length)
    expect(tools.sort()).toEqual(['call_tools_0_0', 'call_tools_0_1', 'call_tools_1_0'])
    expect(items.filter((item) => item.kind === 'assistant').map((item) => (item as { text: string }).text)).toEqual(['All three tools ran.'])
    expect(items.filter((item) => item.kind === 'user').map((item) => (item as { text: string }).text)).toEqual(['[[hh:tools]] Run the tools.'])
  })

  it('live turn PLUS its committed rows keeps each chip\'s live status and output (round-2 x1 #1)', () => {
    // The resume projection carries no tool output (recorded S4), so after the
    // turn's history commits, the live results must survive: the failed read
    // stays failed and every chip keeps what the tool returned.
    // Production order: ONE reconciler sees the live events, then the turn's
    // history fetch (HermesHeadless.scheduleHistoryFetch → applyHistory).
    const { created, events, resumed } = s4()
    const semantic: SemanticEvent[] = []
    const committed: CommittedRow[] = []
    const reconciler = new ConversationReconciler({
      semantic: (event) => semantic.push(event), committed: (row) => committed.push(row), historyReset: () => undefined,
      historyCaughtUp: () => undefined, activity: () => undefined, session: () => undefined, requestOpened: () => undefined,
      requestClosed: () => undefined, turnSettled: () => undefined, reclaimed: () => undefined, unknown: () => undefined, notice: () => undefined, noticeCleared: () => undefined, sideAnswer: () => undefined,
    })
    reconciler.applySnapshot(created, 'snapshot')
    for (const event of events) reconciler.applyEvent(event)
    reconciler.applyHistory(resumed.messages)
    const mapper = createHermesTranscriptEntryMapper()
    const entries = committed.flatMap((row) => mapper.map({ hermes: 1, ...row } as unknown as Record<string, unknown>).entries)
    const items = chat(entries, semantic)
    const tools = items.filter((item) => item.kind === 'tool') as Array<{ toolUseId: string; status: string; result: string | null }>
    expect(tools.map((tool) => [tool.toolUseId, tool.status])).toEqual([
      ['call_tools_0_0', 'done'],
      ['call_tools_0_1', 'error'],
      ['call_tools_1_0', 'done'],
    ])
    expect(tools.every((tool) => tool.result !== null && tool.result.length > 0)).toBe(true)
  })

  it('after a reload (committed rows only): the same conversation, tools shown as finished', () => {
    const { resumed } = s4()
    const items = chat(committedEntries(resumed.messages, String(resumed.stored_session_id ?? '')), [])
    expect(shape(items)).toEqual([
      'user:[[hh:tools]] Run the tools.',
      'tool:call_tools_0_0:done',
      'tool:call_tools_0_1:done',
      'tool:call_tools_1_0:done',
      'assistant:All three tools ran.',
    ])
    // Hermes' resume projection carries no tool output (recorded); the chip
    // says so instead of showing an empty result.
    expect(items.filter((item) => item.kind === 'tool').every((item) => (item as { result: string | null }).result === null)).toBe(true)
  })

  it('mid-turn: finished chips done, the running one running, no answer yet', () => {
    const { created, events } = s4()
    const cut = events.findIndex((event) => event.type === 'tool.start' && (event.payload as { tool_id: string }).tool_id === 'call_tools_1_0')
    const items = chat([], liveEvents(created, events.slice(0, cut + 1)))
    expect(shape(items)).toEqual([
      'tool:call_tools_0_0:done',
      'tool:call_tools_0_1:error',
      'tool:call_tools_1_0:running',
    ])
  })
})

// ---------------------------------------------------------------------------
// Folding a run of work into one row (#1508), on the same recorded S4 turn:
// three tools, the middle one failing, then the answer. Review A (#1509)
// found no test pinned the row identity memo relies on or the live summary.
// ---------------------------------------------------------------------------

const activityOf = (rows: ChatRowItem[]) => rows.filter((row): row is Extract<ChatRowItem, { kind: 'activity' }> => row.kind === 'activity')

describe('a folded run of work (recorded S4)', () => {
  it('keeps its row object while nothing in it changed, so memo skips it', () => {
    const { created, events } = s4()
    const live = liveEvents(created, events)
    const first = stabilizeChat(null, chat([], live))
    const rows = groupActivity(first, null)
    const again = groupActivity(stabilizeChat(first, chat([], live)), rows)
    expect(activityOf(again)).toHaveLength(1)
    expect(activityOf(again)[0]).toBe(activityOf(rows)[0])
  })

  it('is a NEW row once its running tool finishes, and the line stops spinning', () => {
    const { created, events } = s4()
    const cut = events.findIndex((event) => event.type === 'tool.start' && (event.payload as { tool_id: string }).tool_id === 'call_tools_1_0')
    const mid = stabilizeChat(null, chat([], liveEvents(created, events.slice(0, cut + 1))))
    const midRows = groupActivity(mid, null)
    const midRun = activityOf(midRows)[0]!
    expect(summarizeActivity(midRun.steps).status).toBe('running')
    // While a tool runs, the line says which one.
    const running = midRun.steps.find((step) => step.kind === 'tool' && step.status === 'running') as Extract<ChatStep, { kind: 'tool' }>
    expect(summarizeActivity(midRun.steps).headline.startsWith(running.name)).toBe(true)

    const done = groupActivity(stabilizeChat(mid, chat([], liveEvents(created, events))), midRows)
    const doneRun = activityOf(done)[0]!
    expect(doneRun.key).toBe(midRun.key)
    expect(doneRun).not.toBe(midRun)
    expect(summarizeActivity(doneRun.steps).status).not.toBe('running')
  })

  it('a failed probe followed by working tools ends ✓ with "1 failed", not a red run', () => {
    const { created, events } = s4()
    const run = activityOf(groupActivity(chat([], liveEvents(created, events))))[0]!
    expect(summarizeActivity(run.steps)).toMatchObject({ status: 'done', failed: 1 })
  })

  it('while the model thinks after a finished tool, the line shows THAT thought\'s heading', () => {
    // Reasoning text: the owner's debug bundle (2026-10-14T16-26-49), as
    // quoted in splitReasoning's header; Hermes stores progress headings
    // inside `reasoning`. No corpus scenario records a headed thought (their
    // thinking.delta is Hermes' spinner text), so the S4 tool steps are
    // followed by that recorded text as a streaming step.
    const { created, events } = s4()
    const tools = activityOf(groupActivity(chat([], liveEvents(created, events))))[0]!.steps
    const thought: ChatStep = { kind: 'reasoning', key: 'live-thought', streaming: true, text: '**Auditing comprehensive Hermes setup** **Checking Gmail watcher cron status** I\'m running a full live audit now' }
    expect(summarizeActivity([...tools, thought])).toMatchObject({ status: 'running', headline: 'Checking Gmail watcher cron status' })
  })

  it('ends a run at the reply: two turns are two runs, each before its own answer (review B2)', () => {
    // Mechanical mutation of the recording: the S4 turn twice in a row, the
    // second copy re-keyed so the two do not collide.
    const { created, events } = s4()
    const turn = chat([], liveEvents(created, events))
    const twice = [...turn, ...turn.map((item) => ({ ...item, key: `${item.key}#2` }))]
    const rows = groupActivity(twice)
    expect(rows.filter((row) => row.kind === 'activity' || row.kind === 'assistant').map((row) => row.kind)).toEqual(['activity', 'assistant', 'activity', 'assistant'])
    expect(activityOf(rows).map((run) => run.steps.length)).toEqual([3, 3])
  })
})
