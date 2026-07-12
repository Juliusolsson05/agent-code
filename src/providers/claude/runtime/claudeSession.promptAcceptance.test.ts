import { describe, expect, it } from 'vitest'

import { ClaudeSession } from './claudeSession.js'

describe('ClaudeSession prompt acceptance', () => {
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
})
