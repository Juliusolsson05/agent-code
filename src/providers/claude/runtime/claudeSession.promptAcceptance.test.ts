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

  it('normalizes Claude-trimmed trailing whitespace without collapsing interior text', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('keep  interior\n')
    ;(session as unknown as { resolvePromptAcceptance(value: unknown, cursor: number): void })
      .resolvePromptAcceptance({
        type: 'user',
        message: { role: 'user', content: 'keep  interior' },
      }, 1)
    await expect(waiter.promise).resolves.toMatchObject({ kind: 'user' })
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

  it('matches the real Claude text-plus-image JSONL shape without weakening exact text matching', async () => {
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
})
