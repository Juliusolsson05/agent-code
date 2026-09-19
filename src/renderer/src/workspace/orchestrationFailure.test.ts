import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { orchestrationChildLifecycle, terminalProviderFailure } from '@renderer/workspace/orchestrationMcp'
import type { SessionMeta } from '@renderer/workspace/types'

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
