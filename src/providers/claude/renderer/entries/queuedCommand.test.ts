import { describe, expect, it } from 'vitest'

import {
  decodeClaudeQueuedCommand,
  decodeClaudeQueuedUserPrompt,
} from './queuedCommand'
import type { Entry } from '@shared/types/transcript'

// Provenance admission for the durable queued-command attachment.
//
// The bar these protect is narrow and important: this decoder is the single
// gate that decides whether a recorded attachment is painted AS THE USER. A
// record that fails to prove human authorship must not reach that path, so
// every check here is about refusing to speak in the user's voice on weak
// evidence — not about queue bookkeeping, which reconcile.test.ts owns.
//
// Malformed provenance is deliberately constructed rather than replayed: the
// recorded corpus contains well-formed sessions, so a hostile or
// version-skewed field shape cannot be sampled from it. The SHAPE around the
// malformed field mirrors the recorded prompt attachments in
// testing/fixtures/rendering-shapes/claude/queued-command.

function attachmentEntry(attachment: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'attachment',
    uuid: 'u-1',
    timestamp: '2026-06-14T14:25:07.012Z',
    attachment,
    ...extra,
  } as unknown as Entry
}

const humanPrompt = (over: Record<string, unknown> = {}) =>
  attachmentEntry({
    type: 'queued_command',
    commandMode: 'prompt',
    prompt: 'run the tests',
    origin: { kind: 'human' },
    ...over,
  })

describe('queued-command provenance admission', () => {
  it('admits a well-formed human prompt', () => {
    const decoded = decodeClaudeQueuedUserPrompt(humanPrompt())
    expect(decoded?.promptText).toBe('run the tests')
    expect(decoded?.isMeta).toBe(false)
  })

  it('admits a legacy prompt that omits isMeta and origin', () => {
    // Older Claude versions wrote neither field for human prompts. This is the
    // shape the whole feature exists to render, so the stricter meta handling
    // below must not catch it.
    const decoded = decodeClaudeQueuedUserPrompt(
      attachmentEntry({
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: 'legacy prompt',
      }),
    )
    expect(decoded?.promptText).toBe('legacy prompt')
  })

  it('declines a prompt whose isMeta is present but not a boolean', () => {
    // `isMeta: "true"` is a string. Comparing with `=== true` read it as
    // false and admitted the record as user-authored chat, so automation text
    // would paint in the user's own voice.
    //
    // This mirrors the rule the same function already applies to `origin`: a
    // present but malformed field is NOT equivalent to the recorded legacy
    // shape that omits it, and the safe reading of unprovable provenance is
    // "not human".
    for (const value of ['true', 'false', 1, 0, {}, [], null]) {
      const entry = humanPrompt({ isMeta: value })
      expect(decodeClaudeQueuedCommand(entry)?.isMeta).toBe(true)
      expect(decodeClaudeQueuedUserPrompt(entry)).toBeNull()
    }
  })

  it('declines when the malformed isMeta sits on the entry rather than the attachment', () => {
    // Both planes are consulted for meta provenance, so both must be strict;
    // otherwise the check is bypassable by writing the field one level up.
    const entry = humanPrompt()
    ;(entry as unknown as Record<string, unknown>).isMeta = 'true'
    expect(decodeClaudeQueuedUserPrompt(entry)).toBeNull()
  })

  it('still declines an explicit boolean meta prompt', () => {
    expect(decodeClaudeQueuedUserPrompt(humanPrompt({ isMeta: true }))).toBeNull()
  })

  it('still declines a present non-human origin', () => {
    expect(decodeClaudeQueuedUserPrompt(humanPrompt({ origin: { kind: 'agent' } }))).toBeNull()
  })
})
