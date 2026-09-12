import { describe, expect, it, vi } from 'vitest'
import type { Entry } from '@shared/types/transcript'
import { claudeUsageLimitNotice } from '@providers/claude/renderer/adapters/usageLimitNotice'
import { codexUsageLimitNotice } from '@providers/codex/renderer/adapters/usageLimitNotice'
import { classifyClaudeDurableEntry } from '@providers/claude/renderer/entries/classify'
import { usageLimitResetLabel } from '@providers/shared/renderer/protocols/usage-limit/model'
import { emptyRuntime, emptySemanticRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { SEMANTIC_ERROR_CAP } from '@renderer/session-runtime/semantic/helpers'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerFeedContextFromRuntime, ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { readerMessagesFromFeedItems } from '@renderer/features/reader/model/readerMessages'
import { applyFeedEvent, createReplayFoldState, slicesFromState } from '@renderer/rendering/replay/reconstructSlices'
import fixture from '../../../../../testing/fixtures/provider-usage-limits/cases.json'

const cap = fixture.codex[0]!
const monthly = fixture.claude

describe('provider limit admission and truthful recovery', () => {
  it('keeps the exact monthly cap separate from its text-only session reset (#820)', () => {
    const notice = claudeUsageLimitNotice(monthly)!
    expect(notice.category).toBe('spend-cap')
    expect(notice.reset).toEqual({ subject: 'session-window', label: '2:10pm (America/Los_Angeles)' })
    expect(usageLimitResetLabel(notice, 'Asia/Tokyo')).toBe('Session reset reported for 2:10pm (America/Los_Angeles)')
    expect(classifyClaudeDurableEntry({ ...monthly, isCompactSummary: true })).toBe('provider-notice')
    expect(classifyClaudeDurableEntry({ ...monthly, subtype: 'compact_boundary' })).toBe('provider-notice')
  })

  it.each([
    { type: 'user' }, { type: 'tool' }, { isApiErrorMessage: false },
    { isApiErrorMessage: undefined }, { error: 'authentication_failed' },
  ])('does not turn an ordinary quoted error into an actionable cap: %j', change => {
    expect(claudeUsageLimitNotice({ ...monthly, ...change })).toBeNull()
  })

  it('preserves unknown provider-authored wording without guessing its subtype', () => {
    const notice = claudeUsageLimitNotice({ ...monthly, message: { content: 'An unfamiliar refusal. See https://untrusted.invalid' } })!
    expect(notice).toMatchObject({ category: 'unknown', title: 'Rate limit reported', reset: undefined })
    expect(notice.originalMessage).toContain('unfamiliar refusal')
  })

  it.each([
    ['rate_limit_reached', 'usage-window', 'manage-usage'],
    ['workspace_owner_credits_depleted', 'credits', 'manage-usage'],
    ['workspace_member_credits_depleted', 'credits', 'ask-owner'],
    ['workspace_owner_usage_limit_reached', 'spend-cap', 'manage-usage'],
    ['workspace_member_usage_limit_reached', 'spend-cap', 'ask-owner'],
  ])('maps the upstream %s reason without inventing a window reset', (reason, category, remedy) => {
    const event = fixture.codex.find(item => item.rateLimitReachedType === reason)!
    const notice = codexUsageLimitNotice(event)!
    expect(notice).toMatchObject({ category, remedy, originalMessage: event.message })
    expect(notice.reset).toEqual(category === 'usage-window' ? { subject: 'blocking-limit', atMs: 1789157400000 } : undefined)
  })

  it('keeps named pools and legacy typed errors useful without requiring new metadata', () => {
    expect(codexUsageLimitNotice({ ...cap, limitId: 'review', limitName: 'Code review' })?.title).toBe('Usage limit reached for Code review')
    expect(codexUsageLimitNotice({ ...cap, requestId: undefined, rateLimitReachedType: undefined })?.category).toBe('usage-window')
    expect(codexUsageLimitNotice({ ...cap, rateLimitReachedType: 'future_reason' })).toMatchObject({ category: 'unknown', remedy: 'manage-usage' })
  })

  it.each([undefined, null, '1789157400', NaN, Infinity, -1, 0, 8_640_000_000_001])('never invents a reset from malformed metadata: %s', resetsAt => {
    expect(codexUsageLimitNotice({ ...cap, resetsAt })?.reset).toBeUndefined()
  })

  it.each([
    { source: 'screen' }, { source: 'rollout' }, { source: undefined },
    { errorType: 'rate_limit', status: 429 }, { errorType: undefined, status: 429 },
    { errorType: 'overloaded' }, { errorType: 'authentication_error' },
    { errorType: 'context_length_exceeded' }, { type: 'text_delta' },
  ])('leaves non-cap signals out of specialized rendering: %j', change => {
    expect(codexUsageLimitNotice({ ...cap, ...change })).toBeNull()
  })

  it.each(['quota_exceeded', 'usage_not_included'])('does not promise a reset for %s', errorType => {
    const notice = codexUsageLimitNotice({ ...cap, errorType })!
    expect(notice.category).toBe('access')
    expect(notice.reset).toBeUndefined()
  })

  it('dates absolute resets in the viewer timezone across midnight and DST, including expired resets', () => {
    const notice = codexUsageLimitNotice({ ...cap, resetsAt: Date.parse('2026-11-01T09:30:00Z') / 1000 })!
    expect(usageLimitResetLabel(notice, 'America/Los_Angeles')).toContain('1:30 AM (America/Los_Angeles)')
    expect(usageLimitResetLabel(notice, 'Asia/Tokyo')).toContain('6:30 PM (Asia/Tokyo)')
    const midnight = codexUsageLimitNotice({ ...cap, resetsAt: Date.parse('2026-09-12T00:30:00Z') / 1000 })!
    expect(usageLimitResetLabel(midnight, 'America/Los_Angeles')).toContain('Sep 11, 2026')
    expect(usageLimitResetLabel(midnight, 'Asia/Tokyo')).toContain('Sep 12, 2026')
    const expired = codexUsageLimitNotice({ ...cap, resetsAt: 1_700_000_000 })!
    expect(usageLimitResetLabel(expired, 'UTC')).toMatch(/^Reset reported for .*2023/)
  })
})

describe('request identity, ledger ownership, and replay', () => {
  it('idempotently retains duplicate deliveries, distinct attempts, run boundaries, and bounded history', () => {
    let state = foldSemanticEvent(emptySemanticRuntime(), cap, 'codex', 'run-a')
    const first = state.errors[0]!
    expect(foldSemanticEvent(state, cap, 'codex', 'run-a')).toBe(state)
    state = foldSemanticEvent(state, { ...cap, requestId: 'next' }, 'codex', 'run-a')
    state = foldSemanticEvent(state, cap, 'codex', 'run-b')
    expect(new Set(state.errors.map(error => error.id)).size).toBe(3)
    expect(state.errors[0]).toBe(first)
    const old = { type: 'api_error', errorType: 'usage_limit_reached', source: 'proxy', message: 'old recording' }
    const priorRun = foldSemanticEvent(emptySemanticRuntime(), old, 'codex', 'run-a')
    const replacement = foldSemanticEvent(emptySemanticRuntime(), old, 'codex', 'run-b')
    expect(replacement.errors[0]?.id).not.toBe(priorRun.errors[0]?.id)
    state = foldSemanticEvent(state, old, 'codex')
    expect(state.errors.at(-1)?.observedAtMs).toBeUndefined()
    expect(state.errors.at(-1)?.id).toBeTruthy()
    for (let i = 0; i < SEMANTIC_ERROR_CAP + 2; i++) state = foldSemanticEvent(state, { ...cap, requestId: `bounded-${i}` }, 'codex', 'run-b')
    expect(state.errors).toHaveLength(SEMANTIC_ERROR_CAP)
    expect(state.errors.some(error => error.id === first.id)).toBe(false)
    expect(state.currentTurn).toBeNull()
  })

  it('paints a no-turn refusal once, preserves chronology, and keeps it after accepted continuation', () => {
    const runtime = emptyRuntime()
    runtime.entries = [{ type: 'user', uuid: 'prompt', timestamp: new Date(cap.ts - 1000).toISOString(), permissionMode: 'default', message: { role: 'user', content: 'continue' } } as Entry]
    runtime.semantic = foldSemanticEvent(runtime.semantic, cap, 'codex', 'run-a')
    const adapter = createLedgerInputAdapter()
    const ledger = createSessionLedger()
    const slices = () => ({ provider: 'codex' as const, sessionId: 'pane-a', entries: runtime.entries, semanticErrors: runtime.semantic.errors, semanticCurrent: runtime.semantic.currentTurn, semanticHistory: runtime.semantic.history, ghosts: runtime.ghosts, streamPhase: runtime.streamPhase, lastJsonlEntryAtMs: null })
    const before = ledger(adapter(slices()).input)
    expect(ledger(adapter(slices()).input)).toBe(before)
    const bridged = ledgerToFeedItems(before, ledgerFeedContextFromRuntime(runtime, 'codex'))
    expect(bridged.dropped).toEqual([])
    expect(bridged.items.map(item => item.type)).toEqual(['entry', 'provider-notice'])
    expect(before.rows[1]?.candidate).toMatchObject({ owner: 'provider-notice', timestampMs: cap.ts })
    expect(before.rows[1]?.candidate.turnId).toBeUndefined()
    expect(readerMessagesFromFeedItems(bridged.items)[0]?.notice?.key).toBe(bridged.items[1]?.key)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(cap.ts + 1000)
    try {
      runtime.semantic = foldSemanticEvent(runtime.semantic, { type: 'turn_started', source: 'proxy', turnId: 'accepted' }, 'codex', 'run-a')
      runtime.semantic = foldSemanticEvent(runtime.semantic, { type: 'turn_delta', source: 'proxy', turnId: 'accepted', fullText: cap.message }, 'codex', 'run-a')
      runtime.semantic = foldSemanticEvent(runtime.semantic, { type: 'turn_completed', source: 'proxy', turnId: 'accepted' }, 'codex', 'run-a')
    } finally { clock.mockRestore() }
    const after = ledger(adapter(slices()).input)
    expect(after.rows.filter(row => row.candidate.owner === 'provider-notice')).toHaveLength(1)
    expect(after.rows.some(row => row.candidate.contentKind === 'assistant-text')).toBe(true)
    expect(runtime.semantic.errors).toHaveLength(1)
  })

  it('replays durable Claude caps with compaction flags and keeps quoted prose separately owned', () => {
    const state = createReplayFoldState('claude', 'pane-a')
    const carrier = { ...monthly, isCompactSummary: true }
    applyFeedEvent(state, 'session:jsonl-entries', { sessionId: 'pane-a', entries: [{ entry: carrier, file: '/synthetic.jsonl' }] })
    // Paginated/repeated history must not create another cap row.
    applyFeedEvent(state, 'session:jsonl-entries', { sessionId: 'pane-a', entries: [{ entry: carrier, file: '/synthetic.jsonl' }] })
    const result = createSessionLedger()(createLedgerInputAdapter()(slicesFromState(state)).input)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.candidate).toMatchObject({ owner: 'provider-notice', sourcePlane: 'committed', contentKind: 'provider-notice', usageLimitNotice: { category: 'spend-cap' } })
  })

  it('recording reconstruction exposes the same request status to the production ledger', () => {
    const state = createReplayFoldState('codex', 'pane-a')
    applyFeedEvent(state, 'session:semantic-event', { sessionId: 'pane-a', event: cap })
    const adapter = createLedgerInputAdapter()
    const ledger = createSessionLedger()
    const result = ledger(adapter(slicesFromState(state)).input)
    expect(result.rows.map(row => row.candidate.contentKind)).toEqual(['provider-notice'])
    applyFeedEvent(state, 'session:screen', { sessionId: 'pane-a', screen: 'unrelated' })
    expect(ledger(adapter(slicesFromState(state)).input)).toBe(result)
  })
})

it('a recorded refusal and duplicate delivery pass the same invariant audit as ordinary rendering', async () => {
  const { parseRecording, replayRecording } = await import('@renderer/rendering/replay/recordedSession')
  const { assertInvariants } = await import('@renderer/rendering/replay/invariants')
  const recording = parseRecording({
    header: { v: 1, recordingId: 'source-derived-cap', sessionId: 'pane-a', provider: 'codex', providerSessionId: null, cwd: '/synthetic', appVersion: 'fixture', startedAtWall: cap.ts },
    events: [
      { t: 0, wall: cap.ts, ch: 'session:started', payload: { sessionId: 'pane-a', kind: 'codex' } },
      ...[1, 2].map(t => ({ t, wall: cap.ts + t, ch: 'session:semantic-event' as const, payload: { sessionId: 'pane-a', event: cap } })),
      ...Array.from({ length: SEMANTIC_ERROR_CAP + 1 }, (_, i) => ({ t: i + 3, wall: cap.ts + i + 3, ch: 'session:semantic-event' as const, payload: { sessionId: 'pane-a', event: { ...cap, requestId: `attempt-${i}` } } })),
    ],
  })
  const result = replayRecording(recording, { projectItems: (ledger, view, provider) => ledgerToFeedItems(ledger, ledgerFeedContextFromRuntime(view, provider)) })
  expect(assertInvariants(result)).toEqual([])
  expect(result.ticks.at(-1)?.ledger.rows).toHaveLength(SEMANTIC_ERROR_CAP)
  const last = result.ticks.at(-1)!
  const broken = { ...last, index: last.index + 1, rows: [] }
  expect(assertInvariants({ ...result, ticks: [last, broken] }).some(violation => violation.kind === 'vanish-without-replacement')).toBe(true)
})

it('Reader follows a new live refusal but does not jump to an archived cap or merge it with quoted prose', async () => {
  const { nextReaderSelection } = await import('@renderer/features/reader/model/readerSelection')
  const reading = { id: 'reading', text: 'Working on the answer', live: true, sourceId: 'turn-a', committed: false }
  const noticeItem = { type: 'provider-notice' as const, key: 'notice-a', sourcePlane: 'semantic' as const, notice: codexUsageLimitNotice(cap)!, order: { phase: 'content' as const, timeMs: cap.ts, sequence: 1, source: 'ledger' } }
  const liveNotice = readerMessagesFromFeedItems([noticeItem])[0]!
  expect(nextReaderSelection([reading], reading.id, [reading, liveNotice], true)).toEqual({ id: liveNotice.id, moved: true })
  expect(nextReaderSelection([reading], reading.id, [reading, liveNotice], false)).toEqual({ id: reading.id, moved: false })
  const archived = readerMessagesFromFeedItems([{ ...noticeItem, sourcePlane: 'committed' }])[0]!
  expect(nextReaderSelection([reading], reading.id, [archived, reading], true)).toEqual({ id: reading.id, moved: false })
  const quotation = { ...reading, id: 'quotation', text: liveNotice.text, live: false, committed: true }
  expect(nextReaderSelection([liveNotice], liveNotice.id, [quotation], false).moved).toBe(true)
})
