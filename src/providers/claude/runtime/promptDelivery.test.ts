import { describe, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// Pins the short-prompt delivery bug (field report: "did not confirm
// pasted prompt before submit (timeout)" for EVERY phone prompt): Claude's
// TUI only renders the [Pasted text #N] placeholder for multiline/long
// pastes, so a delivery protocol that always pastes and hard-requires the
// placeholder can never deliver a short prompt. The fix mirrors the
// desktop composer's routing (composerSubmit.ts): plain text+\r for short
// single-line prompts, bracketed paste + placeholder confirmation for
// paste-like ones.

function makeIo(prompt: string, placeholderKind: string): {
  io: PromptDeliveryIo
  writes: string[]
  awaitPastePlaceholder: ReturnType<typeof vi.fn>
} {
  const writes: string[] = []
  const awaitPastePlaceholder = vi.fn(async () => ({ kind: placeholderKind }))
  const io = {
    sessionId: 's1',
    prompt,
    write: (data: string) => {
      writes.push(data)
      return true
    },
    session: { awaitPastePlaceholder },
  } as unknown as PromptDeliveryIo
  return { io, writes, awaitPastePlaceholder }
}

describe('deliverClaudePrompt routing', () => {
  it('short single-line prompts go plain text+\\r — no paste, no placeholder wait', async () => {
    const { io, writes, awaitPastePlaceholder } = makeIo('fix the bug', 'timeout')
    const result = await deliverClaudePrompt(io)
    expect(result).toEqual({ ok: true })
    expect(writes).toEqual(['fix the bug\r'])
    expect(awaitPastePlaceholder).not.toHaveBeenCalled()
  })

  it('multiline prompts paste and require the placeholder', async () => {
    const { io, writes } = makeIo('line one\nline two', 'appeared')
    const result = await deliverClaudePrompt(io)
    expect(result).toEqual({ ok: true })
    expect(writes).toEqual(['\x1b[200~line one\nline two\x1b[201~', '\r'])
  })

  it('long prompts paste and require the placeholder', async () => {
    const long = 'x'.repeat(150)
    const { io, writes } = makeIo(long, 'appeared')
    const result = await deliverClaudePrompt(io)
    expect(result).toEqual({ ok: true })
    expect(writes[0]).toBe(`\x1b[200~${long}\x1b[201~`)
  })

  it('paste-like prompts still fail loudly when the placeholder never appears', async () => {
    const { io, writes } = makeIo('line one\nline two', 'timeout')
    const result = await deliverClaudePrompt(io)
    expect(result.ok).toBe(false)
    // Critically: Enter must NOT be sent after an unconfirmed paste.
    expect(writes).toEqual(['\x1b[200~line one\nline two\x1b[201~'])
  })
})
