import { describe, expect, it } from 'vitest'

import { SESSION_LIFECYCLE_AREA } from '@shared/lifecycle/events'
import { SessionLifecycleJournal, type LifecycleJournalSink } from './SessionLifecycleJournal'

type Recorded = Parameters<LifecycleJournalSink['record']>[0]

function fakeSink(): { sink: LifecycleJournalSink; records: Recorded[] } {
  const records: Recorded[] = []
  return {
    records,
    sink: {
      record(input) {
        records.push(input)
      },
    },
  }
}

describe('SessionLifecycleJournal', () => {
  it('records a known event under the session.lifecycle area with its session id', () => {
    const { sink, records } = fakeSink()
    const lifecycle = new SessionLifecycleJournal(sink)

    lifecycle.session('recover.adopted', 'sess-1', { kind: 'claude', durationMs: 42 })

    expect(records).toHaveLength(1)
    expect(records[0].area).toBe(SESSION_LIFECYCLE_AREA)
    expect(records[0].name).toBe('recover.adopted')
    expect(records[0].ids).toEqual({ sessionId: 'sess-1' })
    expect(records[0].data).toEqual({ kind: 'claude', durationMs: 42 })
  })

  it('derives severity from the event name rather than the call site', () => {
    const { sink, records } = fakeSink()
    const lifecycle = new SessionLifecycleJournal(sink)

    lifecycle.session('recover.adopted', 'sess-1')
    lifecycle.session('recover.failed', 'sess-1', { code: 'start-failed' })

    expect(records[0].severity).toBe('info')
    expect(records[1].severity).toBe('warn')
  })

  it('drops payload keys that are not allowlisted', () => {
    // The allowlist is what makes "metadata only" a structural guarantee rather
    // than a convention. A call site that reaches for a content-bearing field
    // must lose the field, not leak it into an always-on on-disk stream.
    const { sink, records } = fakeSink()
    const lifecycle = new SessionLifecycleJournal(sink)

    lifecycle.session('submit.result', 'sess-1', {
      ok: false,
      // @ts-expect-error deliberately passing keys outside the allowlist. One
      // directive covers the literal: excess-property checking reports the
      // object once, at its first offending key.
      prompt: 'refactor the auth module',
      transcript: 'assistant said things',
    })

    expect(records[0].data).toEqual({ ok: false })
  })

  it('drops non-primitive values so nested payloads cannot bypass the allowlist', () => {
    // `sanitizePerformanceData` in the underlying journal only inspects TOP-LEVEL
    // keys. An allowlisted key holding an object would therefore carry arbitrary
    // nested content straight to disk. Flat primitives keep the allowlist total.
    const { sink, records } = fakeSink()
    const lifecycle = new SessionLifecycleJournal(sink)

    lifecycle.session('submit.result', 'sess-1', {
      // @ts-expect-error deliberately passing a non-primitive for an allowlisted key
      reason: { nested: 'content' },
      ok: true,
    })

    expect(records[0].data).toEqual({ ok: true })
  })

  it('omits data entirely when nothing survives the allowlist', () => {
    const { sink, records } = fakeSink()
    const lifecycle = new SessionLifecycleJournal(sink)

    // @ts-expect-error deliberately passing only unallowlisted keys
    lifecycle.session('wake.request', 'sess-1', { secret: 'x' })

    expect(records[0].data).toBeUndefined()
  })

  it('never propagates a throwing sink to the caller', () => {
    // Emit points sit on the recovery path — the code that repairs the app after
    // a crash. A diagnostic that can throw would turn "boot is slow" into "boot
    // is broken". This is the single most important property in the file.
    const lifecycle = new SessionLifecycleJournal({
      record() {
        throw new Error('disk is on fire')
      },
    })

    expect(() => lifecycle.session('recover.spawned', 'sess-1')).not.toThrow()
  })

  it('is an inert no-op when constructed without a sink', () => {
    // SessionManager is constructed without a journal in tests, and the incident
    // journal itself degrades to a no-op when its directory is unwritable.
    const lifecycle = new SessionLifecycleJournal(null)

    expect(() => lifecycle.session('rehydrate.start', 'sess-1')).not.toThrow()
  })
})
