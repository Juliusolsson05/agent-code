import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { orchestrationChildLifecycle, terminalProviderFailure } from '@renderer/workspace/orchestrationMcp'
import type { SessionMeta } from '@renderer/workspace/types'
import { mapGrokEntryToFeedEntries } from '@providers/grok/renderer/transcript/mapper'
import { mapOpencodeMessageToFeedEntries } from '@providers/opencode/renderer/transcript/mapper'

// #1018: an orchestration child whose provider turn failed (a usage limit, an
// auth rejection) reported `waiting` forever, which main turned into
// `prompt_sent`, so the parent could not tell a dead child from a slow one.
//
// Every sequence below is a RECORDED feed-debug stream from this machine
// (testing/fixtures/orchestration-api-error, see CATALOG.md and README.md):
// process-state transitions and semantic events in their recorded order and
// timing. Feed-debug rows carry only the event type, so the api_error payload
// is the catalog's derived event for that recording (documented per fixture).
// Events go through the renderer's REAL semantic fold, and the lifecycle is
// the one list/wait/read report.

type FeedEvent = { tMs: number; layer: string; kind: string; data?: Record<string, unknown> }
type Fixture = { feedDebug: { anchorEpochMs: number; events: FeedEvent[] }; derivedSemanticApiError?: { event: Record<string, unknown> } }

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../../testing/fixtures/orchestration-api-error/${name}.json`), 'utf8')) as Record<string, unknown>

/** Replays a recording, calling `observe` with the lifecycle after each step. */
function replay(fixture: Fixture, kind: SessionMeta['kind']) {
  const meta = { kind, cwd: '/repo' } as SessionMeta
  let runtime: SessionRuntime = { ...emptyRuntime(), processStatus: 'started', inputReady: true }
  const steps: Array<{ tMs: number; kind: string; lifecycle: string }> = []
  for (const event of fixture.feedDebug.events) {
    const ts = fixture.feedDebug.anchorEpochMs + event.tMs
    if (event.layer === 'STATE' && event.kind === 'process_state') {
      runtime = { ...runtime, processActive: event.data?.active === true }
    } else if (event.layer === 'SEM' && (event.kind === 'api_error' || event.kind === 'turn_started' || event.kind === 'turn_completed')) {
      const payload = event.kind === 'api_error'
        ? { ...fixture.derivedSemanticApiError!.event, ts }
        : { type: event.kind, turnId: 'recorded-turn', ts }
      runtime = { ...runtime, semantic: foldSemanticEvent(runtime.semantic, payload, kind!) }
    } else {
      continue
    }
    steps.push({ tMs: event.tMs, kind: `${event.layer}:${event.kind}`, lifecycle: orchestrationChildLifecycle(runtime, meta) })
  }
  return { runtime, meta, steps }
}

describe('a child whose provider turn failed reports `failed` (#1018)', () => {
  it('OpenCode structured, usage limit after 5 retries: running through every retry, failed once idle', () => {
    const { runtime, meta, steps } = replay(load('opencode-structured-usage-limit-terminal') as Fixture, 'opencode')
    const errorAt = steps.findIndex(step => step.kind === 'SEM:api_error')
    // Retries keep the process active and emit no api_error: never failed.
    expect(steps.slice(0, errorAt).map(step => step.lifecycle)).not.toContain('failed')
    expect(steps.at(-1)!.lifecycle).toBe('failed')
    expect(terminalProviderFailure(runtime, meta)?.message).toBeTruthy()
  })

  it('OpenCode Terminal, usage limit after retries: failed with the provider\'s own text', () => {
    const { runtime, meta, steps } = replay(load('opencode-terminal-usage-limit-after-retries') as Fixture, 'opencode')
    expect(steps.at(-1)!.lifecycle).toBe('failed')
    expect(terminalProviderFailure(runtime, meta)?.message).toMatch(/usage limit/i)
  })

  // A guard rather than a fail-first test: the recording has no api_error at
  // all, so it passed before #1018 too. It pins that retries alone (5
  // `retrying` statuses, processActive true) can never produce `failed`.
  it('OpenCode Terminal, a retry still in flight: never failed', () => {
    const { steps } = replay(load('opencode-terminal-retry-in-flight') as Fixture, 'opencode')
    expect(steps.map(step => step.lifecycle)).not.toContain('failed')
  })

  it('Codex usage limit: the error arrives while the process is still active, and failed waits for idle', () => {
    const { runtime, meta, steps } = replay(load('codex-usage-limit-terminal') as Fixture, 'codex')
    const errorStep = steps.find(step => step.kind === 'SEM:api_error')!
    // Recorded: api_error at 10.3 s, the process idle at 13.4 s.
    expect(errorStep.lifecycle).toBe('running')
    expect(steps.at(-1)!.lifecycle).toBe('failed')
    expect(terminalProviderFailure(runtime, meta)?.message).toBe('The usage limit has been reached')
  })

  it('Claude usage limit: the committed error entry is the failure, not an answer', () => {
    const claude = load('claude-usage-limit-terminal') as { a_committedEntries: Array<Record<string, unknown>> }
    const meta = { kind: 'claude', cwd: '/repo' } as SessionMeta
    const runtime: SessionRuntime = { ...emptyRuntime(), processStatus: 'started', inputReady: true, entries: claude.a_committedEntries as never }
    // It used to read `completed`, with the limit text as the child's answer.
    expect(orchestrationChildLifecycle(runtime, meta)).toBe('failed')
    expect(terminalProviderFailure(runtime, meta)?.message).toMatch(/session limit/)

    // A later real answer (Claude continuing automatically, or a re-prompt)
    // beats the old error.
    const errorAt = Date.parse(String(claude.a_committedEntries[0]!.timestamp))
    const answer = { type: 'assistant', timestamp: new Date(errorAt + 60_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }
    expect(orchestrationChildLifecycle({ ...runtime, entries: [...runtime.entries, answer] as never }, meta)).toBe('completed')
  })
})

// Review of #1044 (2026-09-19): the cases where a healthy child must NOT read
// `failed`. The first version failed each of them.
describe('a child that did not fail never reports `failed` (#1044 review)', () => {
  const T1 = Date.parse('2026-09-19T10:00:00Z')
  const idle = (): SessionRuntime => ({ ...emptyRuntime(), processStatus: 'started', inputReady: true })
  const withError = (runtime: SessionRuntime, event: Record<string, unknown>, kind: SessionMeta['kind']) =>
    ({ ...runtime, semantic: foldSemanticEvent(runtime.semantic, { type: 'api_error', turnId: null, ...event }, kind!) })

  it('Grok: an old error followed by a later answer reads completed, through the real Grok mapper', () => {
    // Grok rows carry no timestamp, so "newer than the latest output" was
    // always true. Turn 1 failed, turn 2 answered, and the child read
    // `failed` (then `prompt_sent` from main) forever. Grok has no failure
    // signal until a recording supports one.
    const meta = { kind: 'grok', cwd: '/repo' } as SessionMeta
    const user = mapGrokEntryToFeedEntries({ sessionId: 's', generation: 0, lineStartOffset: 100, item: { type: 'user', content: [{ type: 'text', text: 'try again' }] } }).entries
    const answer = mapGrokEntryToFeedEntries({ sessionId: 's', generation: 0, lineStartOffset: 200, item: { type: 'assistant', content: 'Done, all tests pass.', tool_calls: [] } }).entries
    expect(answer[0]!.timestamp).toBeUndefined()
    const runtime = { ...withError(idle(), { message: 'rate limited', source: 'grok-acp', ts: T1 }, 'grok'), entries: [...user, ...answer] as never }
    expect(terminalProviderFailure(runtime, meta)).toBeNull()
    expect(orchestrationChildLifecycle(runtime, meta)).toBe('completed')
  })

  it('OpenCode: an instance-wide error (a broken skill file) never fails the turn, and still counts for nothing after the answer', () => {
    // OpenCode stamps a step's time.created BEFORE it loads skills, so a
    // skill parse error lands after the final answer's timestamp. The
    // package now marks session-less errors 'instance' (opencode-headless#16).
    const meta = { kind: 'opencode', cwd: '/repo' } as SessionMeta
    const answer = mapOpencodeMessageToFeedEntries({ info: { id: 'msg_1', role: 'assistant', time: { created: T1, completed: T1 + 20_000 } }, parts: [{ type: 'text', text: 'Here is the full answer.' }] }).entries
    const runtime = { ...withError(idle(), { message: 'Failed to parse skill /x/SKILL.md', errorType: 'instance', source: 'opencode-sse', ts: T1 + 40 }, 'opencode'), entries: answer as never }
    expect(orchestrationChildLifecycle(runtime, meta)).toBe('completed')
  })

  it('an assistant row whose time cannot be read means "not failed": the order is unknown', () => {
    // No provider writes such a row today (review checked the Claude JSONL,
    // the Codex rollout and OpenCode time.created). This pins the direction a
    // drifting mapper must fail in: a slow wait for the parent, never a
    // healthy child reported dead.
    const meta = { kind: 'codex', cwd: '/repo' } as SessionMeta
    const answer = { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
    const runtime = { ...withError(idle(), { requestId: 'req-1', message: 'boom', status: 500, source: 'proxy', ts: T1 }, 'codex'), entries: [answer] as never }
    expect(terminalProviderFailure(runtime, meta)).toBeNull()
    expect(terminalProviderFailure({ ...runtime, entries: [] }, meta)?.message).toBe('boom')
  })

  it('a meta with no kind is Claude, so its committed error still fails the child', () => {
    const claude = load('claude-usage-limit-terminal') as { a_committedEntries: Array<Record<string, unknown>> }
    const runtime: SessionRuntime = { ...idle(), entries: claude.a_committedEntries as never }
    expect(orchestrationChildLifecycle(runtime, { cwd: '/repo' } as SessionMeta)).toBe('failed')
  })

  it('Codex: an old error followed by a newer rollout answer reads completed', () => {
    const meta = { kind: 'codex', cwd: '/repo' } as SessionMeta
    const answer = { type: 'assistant', uuid: 'a', timestamp: new Date(T1 + 3000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
    const runtime = { ...withError(idle(), { requestId: 'req-1', message: 'boom', status: 500, source: 'proxy', ts: T1 }, 'codex'), entries: [answer] as never }
    expect(orchestrationChildLifecycle(runtime, meta)).toBe('completed')
  })

  // Recorded OpenCode Terminal sequences with no retries before the error
  // (opencode-terminal-nonretryable-and-abort.json). The api_error payload is
  // the catalog's derived message plus the error name from the recorded
  // database row, which is what opencode-terminal-headless#4 now forwards as
  // errorType.
  const nonRetryable = load('opencode-terminal-nonretryable-and-abort') as Record<string, { feedDebug: Fixture['feedDebug'] }>
  const caseFixture = (key: string, event: Record<string, unknown>): Fixture => ({
    feedDebug: nonRetryable[key]!.feedDebug,
    derivedSemanticApiError: { event: { type: 'api_error', turnId: null, source: 'opencode-sse', ...event } },
  })

  it('OpenCode Terminal, the user pressed Esc (recorded case b): never failed', () => {
    const { steps } = replay(caseFixture('b_userAbort', { message: 'Aborted', errorType: 'MessageAbortedError' }), 'opencode')
    expect(steps.some(step => step.kind === 'SEM:api_error')).toBe(true)
    expect(steps.map(step => step.lifecycle)).not.toContain('failed')
  })

  it('OpenCode Terminal, a 403 then the user re-prompted (recorded case c): failed while idle, running again once the new turn starts', () => {
    // Case c has no database rows of its own; its 403 is the same free-tier
    // rejection as case a, whose row supplies the text and name.
    const { steps } = replay(caseFixture('c_nonRetryable403ThenUserRetry', {
      message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
      errorType: 'APIError',
    }), 'opencode')
    const reprompt = steps.findIndex(step => step.tMs === 9693)
    expect(steps.slice(0, reprompt).at(-1)!.lifecycle).toBe('failed')
    expect(steps.at(-1)!.lifecycle).toBe('running')
  })
})
