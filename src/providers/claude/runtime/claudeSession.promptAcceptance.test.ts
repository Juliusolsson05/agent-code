import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClaudeSession } from './claudeSession.js'

afterEach(() => vi.useRealTimers())

function installPromptSurface(
  session: ClaudeSession,
  initial: {
    composer?: 'empty' | 'drafted' | 'unpainted'
    conditions?: Record<string, { kind: string; actions: unknown[] }>
  } = {},
): {
  setComposer(value: 'empty' | 'drafted' | 'unpainted'): void
  setConditions(value: Record<string, { kind: string; actions: unknown[] }>): void
  getComposerState: ReturnType<typeof vi.fn>
} {
  let composer = initial.composer ?? 'empty'
  let conditions = initial.conditions ?? {}
  const getComposerState = vi.fn(() => composer)
  ;(session as unknown as { headless: unknown }).headless = {
    getScreen: () => '',
    getComposerState,
    getConditionSnapshot: () => ({ provider: 'claude', conditions, ts: Date.now() }),
  }
  return {
    setComposer: value => { composer = value },
    setConditions: value => { conditions = value },
    getComposerState,
  }
}

function refreshPromptGate(session: ClaudeSession): void {
  ;(session as unknown as { refreshPromptGate(): void }).refreshPromptGate()
}

function promptGateState(session: ClaudeSession): { kind: string } {
  return (session as unknown as { promptGateState: { kind: string } }).promptGateState
}

describe('ClaudeSession prompt acceptance', () => {
  it('makes a fresh session ready immediately after transcript attachment', () => {
    const session = new ClaudeSession()
    installPromptSurface(session)
    const seen: boolean[] = []
    session.on('input-readiness', input => seen.push(input.ready))
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true
    refreshPromptGate(session)

    expect(seen).toEqual([true])
    expect(session.isPromptAcceptanceReady()).toBe(true)
  })

  it('lets immediate post-spawn delivery await the replay quiet-window event', async () => {
    vi.useFakeTimers()
    const session = new ClaudeSession({ resumeSessionId: 'resume-me' })
    installPromptSurface(session)
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { armTranscriptReplayQuietWindow(): void })
      .armTranscriptReplayQuietWindow()

    const readiness = session.awaitReadyForPrompt({ timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(249)
    let settled = false
    void readiness.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(readiness).resolves.toEqual({ kind: 'ready', waitedMs: 250 })
  })

  it('bounds readiness waiting and removes lifecycle listeners on timeout', async () => {
    vi.useFakeTimers()
    const session = new ClaudeSession()
    installPromptSurface(session, { composer: 'unpainted' })
    const readiness = session.awaitReadyForPrompt({ timeoutMs: 100 })

    expect(session.listenerCount('prompt-gate')).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    await expect(readiness).resolves.toEqual({
      kind: 'timeout',
      waitedMs: 100,
      lastState: { kind: 'warming', reason: 'replay-pending' },
    })
    expect(session.listenerCount('prompt-gate')).toBe(0)
  })

  it('does not publish readiness until Claude paints an empty composer', () => {
    vi.useFakeTimers()
    const session = new ClaudeSession()
    const surface = installPromptSurface(session, { composer: 'unpainted' })
    const seen: boolean[] = []
    session.on('input-readiness', input => seen.push(input.ready))
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true
    refreshPromptGate(session)

    expect(seen).toEqual([])
    expect(session.isPromptAcceptanceReady()).toBe(false)

    surface.setComposer('empty')
    refreshPromptGate(session)
    expect(seen).toEqual([true])
    expect(session.isPromptAcceptanceReady()).toBe(true)
  })

  it('returns structured blockers and human drafts immediately without consuming the clock', async () => {
    const session = new ClaudeSession()
    const surface = installPromptSurface(session, {
      conditions: {
        'claude.trust-dialog': {
          kind: 'claude.trust-dialog',
          actions: [{ kind: 'pty', keys: '\r' }],
        },
      },
    })
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true

    await expect(session.awaitReadyForPrompt({ timeoutMs: 10_000 })).resolves.toEqual({
      kind: 'blocked',
      condition: 'claude.trust-dialog',
      resolvable: true,
    })

    surface.setConditions({})
    surface.setComposer('drafted')
    refreshPromptGate(session)
    await expect(session.awaitReadyForPrompt({ timeoutMs: 10_000 })).resolves.toEqual({
      kind: 'occupied',
      reason: 'human-draft',
    })
  })

  it('moves back to warming when transcript replay safety is re-armed', () => {
    const session = new ClaudeSession({ resumeSessionId: 'resume-me' })
    installPromptSurface(session)
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true
    refreshPromptGate(session)
    expect(session.isPromptAcceptanceReady()).toBe(true)

    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = false
    refreshPromptGate(session)
    expect(session.isPromptAcceptanceReady()).toBe(false)
  })

  it('fans one gate transition out to many waiters without reparsing per waiter', async () => {
    const session = new ClaudeSession()
    session.setMaxListeners(0)
    const surface = installPromptSurface(session, { composer: 'unpainted' })
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true

    const waits = Array.from({ length: 50 }, () =>
      session.awaitReadyForPrompt({ timeoutMs: 10_000 }),
    )
    const readsBeforeTransition = surface.getComposerState.mock.calls.length
    surface.setComposer('empty')
    refreshPromptGate(session)

    await expect(Promise.all(waits)).resolves.toEqual(
      Array.from({ length: 50 }, () => ({ kind: 'ready', waitedMs: expect.any(Number) })),
    )
    // The headless package already parsed the frame once. ClaudeSession reads
    // that cached classification once for the transition and gives the same
    // immutable state to every waiter; listener count does not multiply parser
    // work.
    expect(surface.getComposerState).toHaveBeenCalledTimes(readsBeforeTransition + 1)
    expect(session.listenerCount('prompt-gate')).toBe(0)
  })

  it('assigns distinct exact transcript ids to concurrent fresh sessions', () => {
    const first = new ClaudeSession()
    const second = new ClaudeSession()
    const transcriptId = (session: ClaudeSession): string =>
      (session as unknown as { transcriptSessionId: string }).transcriptSessionId
    expect(transcriptId(first)).not.toBe(transcriptId(second))
    expect(transcriptId(new ClaudeSession({ resumeSessionId: 'resume-id' }))).toBe('resume-id')
  })

  it('matches only an exact future user or queue JSONL payload', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('line one\r\nline two')
    let cursor = 0
    const resolveEntry = (entry: unknown) => {
      cursor += 1
      ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
        .resolvePromptAcceptance(entry, cursor)
    }

    // A near-match must not acknowledge delivery: substring matching would let
    // a manually edited prompt or a later appended dot recreate the original
    // false-success bug.
    resolveEntry({
      type: 'user',
      message: { role: 'user', content: 'line one\nline two.' },
    })
    resolveEntry({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'line one\nline two',
    })

    await expect(waiter.promise).resolves.toMatchObject({ kind: 'queue' })
  })

  it('matches across whitespace transforms while trailing trim still works', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('keep  interior\n')
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'user',
        message: { role: 'user', content: 'keep  interior' },
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  // ---------------------------------------------------------------------------
  // REAL-DATA FIXTURE — the 2026-08-30 22:07:38 false acceptance-timeout.
  //
  // FIXTURE_SENT is the exact `draftInput` preserved in debug bundle
  // 2026-08-30T22-07-43-944-88c29f92 (482 chars, 8 raw TAB bytes from a pasted
  // table). FIXTURE_ACCEPTED is the exact `message.content` Claude committed
  // to transcript 47211034-…jsonl 316ms after submit.begin (505 chars — each
  // tab rewritten to a constant four spaces; the queue-operation entry
  // carried the identical expanded form, proving the transform happens on
  // paste ingestion inside Claude's composer, so NO transcript witness can
  // ever equal the sent bytes).
  //
  // Under byte-exact interior matching this pair never matched: the delivery
  // succeeded end-to-end and was reported failed after 20s, the stale draft
  // was restored over the user's composer, and the resend guard blocked the
  // retry. A corpus sweep the same day found this made 21 OF 21 recorded
  // acceptance-timeouts false. These strings are the regression fence: if
  // canonicalization ever tightens back toward byte-exactness, this test —
  // not a user with a debug bundle — is what catches it.
  // ---------------------------------------------------------------------------
  const FIXTURE_SENT = "but you can for sure go about and close these ones because they are for sure superseeded. \tTitle\tWhy I think it's obsolete\n#343\tCompaction rendering has split ownership\tThe thing it complains about was structurally removed. One decision point now.\n#346\tStreaming vs committed markdown lists diverge\tSame cohort; the two paths were unified under the ledger + provider painters.\n#345\tLive compaction leaks raw XML into feed\tPR #427 added model-level guards in the semantic collector.\n"
  const FIXTURE_ACCEPTED = "but you can for sure go about and close these ones because they are for sure superseeded.     Title    Why I think it's obsolete\n#343    Compaction rendering has split ownership    The thing it complains about was structurally removed. One decision point now.\n#346    Streaming vs committed markdown lists diverge    Same cohort; the two paths were unified under the ledger + provider painters.\n#345    Live compaction leaks raw XML into feed    PR #427 added model-level guards in the semantic collector."

  it('accepts the recorded tab-expanded transcript entry (2026-08-30 false timeout)', async () => {
    const session = new ClaudeSession()
    // timeoutMs keeps a regression RED-fast: without it a broken matcher
    // stalls this test on the 10s real-timer default before failing.
    const waiter = session.armPromptAcceptance(FIXTURE_SENT, { timeoutMs: 200 })
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'user',
        message: { role: 'user', content: FIXTURE_ACCEPTED },
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  it('accepts the same delivery via the recorded queue-operation shape', async () => {
    // Mid-turn deliveries surface as queue-operation first (22:07:38.150Z,
    // 280ms before the user entry). Matching the queue shape is what makes a
    // busy-session submit confirm fast instead of waiting on turn commit.
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance(FIXTURE_SENT, { timeoutMs: 200 })
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'queue-operation',
        operation: 'enqueue',
        content: FIXTURE_ACCEPTED,
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'queue' })
  })

  it('still refuses a non-whitespace edit of the same prompt', async () => {
    // The collapse must not weaken the guard exactness actually existed for:
    // a real content difference (here, an appended word) stays unmatched.
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance(FIXTURE_SENT, { timeoutMs: 30 })
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'user',
        message: { role: 'user', content: FIXTURE_ACCEPTED + ' extra' },
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'timeout' })
  })

  it('matches an NFD-armed short prompt against its NFC-committed entry', async () => {
    // Short (non-paste-like) prompts are typed through Claude's Cursor, whose
    // MeasuredText NFC-normalizes (vendor utils/Cursor.ts:1135). NFD input is
    // what macOS filenames and PDF copy-paste produce. Found by adversarial
    // review of the whitespace fix — collapse alone does not cover it.
    const session = new ClaudeSession()
    const nfd = 'read cafe\u0301.txt'          // e + combining acute (NFD)
    const nfc = 'read caf\u00e9.txt'           // precomposed é (NFC)
    const waiter = session.armPromptAcceptance(nfd, { timeoutMs: 200 })
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'user',
        message: { role: 'user', content: nfc },
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  it('reports which filter starved a timed-out waiter', async () => {
    // The diagnostic the 2026-08-30 investigation lacked: the timeout alone
    // said nothing, and naming the guilty filter took a debug bundle plus a
    // byte-level diff. exact=1 here is that diff, pre-computed and journaled.
    const session = new ClaudeSession()
    ;(session as unknown as { promptAcceptanceIngestCursor: number })
      .promptAcceptanceIngestCursor = 1
    const waiter = session.armPromptAcceptance('the real prompt', { timeoutMs: 40 })
    const resolve = (entry: unknown, cursor: number): void => {
      ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
        .resolvePromptAcceptance(entry, cursor)
    }
    // rejected by the ingest cursor (arrived before arming)
    resolve({ type: 'user', message: { role: 'user', content: 'the real prompt' } }, 1)
    // rejected by text inequality (a genuinely different entry)
    resolve({ type: 'user', message: { role: 'user', content: 'another prompt' } }, 2)
    await expect(waiter.promise).resolves.toMatchObject({
      kind: 'timeout',
      nearMisses: { cursor: 1, timestamp: 0, image: 0, exact: 1 },
    })
  })

  it('ignores an entry at or before the waiter ingest cursor', async () => {
    const session = new ClaudeSession()
    ;(session as unknown as { promptAcceptanceIngestCursor: number })
      .promptAcceptanceIngestCursor = 4
    const waiter = session.armPromptAcceptance('continue', { timeoutMs: 100 })
    const resolve = (cursor: number): void => {
      ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
        .resolvePromptAcceptance({
          type: 'user', message: { role: 'user', content: 'continue' },
        }, cursor)
    }
    resolve(4)
    resolve(5)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  it('does not acknowledge image-only delivery from an unrelated empty tool-result user entry', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('', {
      requiresImage: true,
      expectedImageCount: 1,
    })
    const resolve = (entry: unknown, cursor: number): void => {
      ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
        .resolvePromptAcceptance(entry, cursor)
    }
    resolve({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
    }, 1)
    resolve({
      type: 'user',
      // Captured from a real Claude 2.1.207 PTY submission. Claude replaces
      // the pasted path with this pill plus the structured base64 block.
      imagePasteIds: [1],
      message: { role: 'user', content: [
        { type: 'text', text: '[Image #1]' },
        { type: 'image', source: { type: 'base64' } },
      ] },
    }, 2)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  it('matches the real Claude text-plus-image JSONL shape without weakening the text guard', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('describe briefly', { expectedImageCount: 1 })
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'user',
        imagePasteIds: [2],
        message: { role: 'user', content: [
          { type: 'text', text: 'describe briefly [Image #2]' },
          { type: 'image', source: { type: 'base64' } },
        ] },
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  it('matches the real Claude busy-session image queue shape', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('inspect', { expectedImageCount: 1 })
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'queue-operation',
        operation: 'enqueue',
        // Captured from the same real PTY while `sleep 12` kept Claude busy.
        content: 'inspect [Image #3]',
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'queue' })
  })

  it('rejects an identical entry timestamped before the waiter armed', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('continue')
    const resolve = (timestamp: string, cursor: number): void => {
      ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
        .resolvePromptAcceptance({
          type: 'user', timestamp,
          message: { role: 'user', content: 'continue' },
        }, cursor)
    }
    resolve('2000-01-01T00:00:00.000Z', 1)
    resolve(new Date(Date.now() + 1).toISOString(), 2)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
  })

  it('reports occupied for as long as the composer holds a draft', () => {
    // No time bound here on purpose. A 10s staleness escape hatch was tried and
    // removed before merge: typing never clears the composer, so it expired
    // mid-sentence and the gate returned 'ready', letting an agent overwrite a
    // half-written human message. Elapsed time cannot distinguish a misread
    // from a user who is still composing.
    vi.useFakeTimers()
    const session = new ClaudeSession()
    installPromptSurface(session, { composer: 'drafted' })
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true
    refreshPromptGate(session)
    expect(promptGateState(session)).toMatchObject({ kind: 'occupied' })

    vi.advanceTimersByTime(600_000)
    refreshPromptGate(session)
    expect(promptGateState(session)).toMatchObject({ kind: 'occupied' })
  })

  it('becomes ready as soon as the composer clears', () => {
    const session = new ClaudeSession()
    const surface = installPromptSurface(session, { composer: 'drafted' })
    ;(session as unknown as { transcriptTailAttached: boolean }).transcriptTailAttached = true
    ;(session as unknown as { transcriptReplayQuiesced: boolean }).transcriptReplayQuiesced = true
    refreshPromptGate(session)
    expect(promptGateState(session)).toMatchObject({ kind: 'occupied' })

    surface.setComposer('empty')
    refreshPromptGate(session)
    expect(promptGateState(session)).toMatchObject({ kind: 'ready' })
  })
})
