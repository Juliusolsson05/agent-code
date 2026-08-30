import { afterEach, describe, expect, it, vi } from 'vitest'

const sendToSessionWindow = vi.hoisted(() => vi.fn())

vi.mock('@main/window/windowRegistry.js', () => ({ sendToSessionWindow }))

import {
  enqueueJsonl,
  flushAndDropJsonl,
  flushJsonl,
} from './jsonlCoalescer.js'

describe('jsonl coalescer observation sidecars', () => {
  const sessionIds = new Set<string>()

  afterEach(() => {
    for (const sessionId of sessionIds) flushAndDropJsonl(sessionId)
    sessionIds.clear()
    sendToSessionWindow.mockReset()
  })

  it('does not add an undefined Codex-only field to provider-neutral entries', () => {
    const sessionId = 'coalescer-non-codex'
    sessionIds.add(sessionId)
    enqueueJsonl(sessionId, { type: 'user' } as never, '/recorded/claude.jsonl')
    flushJsonl(sessionId)

    // The window registry owns routing after multi-window adoption; the
    // coalesced payload is the third argument, after pane id and channel.
    const payload = sendToSessionWindow.mock.calls[0]?.[2] as {
      entries: Array<Record<string, unknown>>
    }
    expect(payload.entries[0]).toEqual({
      entry: { type: 'user' },
      file: '/recorded/claude.jsonl',
    })
    expect(Object.hasOwn(payload.entries[0]!, 'observation')).toBe(false)
  })

  it('preserves an observed Codex rollout generation and ordinal', () => {
    const sessionId = 'coalescer-codex'
    sessionIds.add(sessionId)
    enqueueJsonl(
      sessionId,
      { type: 'session_meta' } as never,
      '/recorded/codex.jsonl',
      { fileGenerationId: '16777234:991882', rolloutByteOffset: 0 },
    )
    flushJsonl(sessionId)

    const payload = sendToSessionWindow.mock.calls[0]?.[2] as {
      entries: Array<Record<string, unknown>>
    }
    expect(payload.entries[0]?.observation).toEqual({
      fileGenerationId: '16777234:991882',
      rolloutByteOffset: 0,
    })
  })
})
