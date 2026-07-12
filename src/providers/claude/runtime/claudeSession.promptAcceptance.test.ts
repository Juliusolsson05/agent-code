import { describe, expect, it } from 'vitest'

import { ClaudeSession } from './claudeSession.js'

describe('ClaudeSession prompt acceptance', () => {
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
