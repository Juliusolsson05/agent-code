import { describe, expect, it } from 'vitest'

import { ClaudeSession } from './claudeSession.js'

describe('ClaudeSession prompt acceptance', () => {
  it('matches only an exact future user or queue JSONL payload', async () => {
    const session = new ClaudeSession()
    const waiter = session.armPromptAcceptance('line one\r\nline two')
    const resolveEntry = (entry: unknown) => {
      ;(session as unknown as { resolvePromptAcceptance(value: unknown): void })
        .resolvePromptAcceptance(entry)
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
})
