import { afterEach, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// #1291: the paste-debug journals hold 4 `rollback-exhausted {presses: 64}`
// against 1 `rollback-cleared`. After absorption timed out, the rollback read
// the composer TEXT-ONLY, and Claude repaints placeholder text (a prompt
// suggestion such as the recorded "yes fix all 9", or a hint) into an emptied
// composer; text-only reads that as a draft, so every kill looked like it
// failed, 64 presses later the prompt was yanked back, and the user was told
// to clear it by hand. The session's attribute-aware state (the one the prompt
// gate uses) classifies dim placeholder text as empty.
afterEach(() => { vi.useRealTimers() })

// Claude's composer box as rendered: divider, prompt row, divider. The row
// holds the same text before our write (a dim suggestion) and after the kill
// (the suggestion repainted), so a text-only read can never see it empty.
const SUGGESTION_SCREEN = ['─'.repeat(40), '❯ yes fix all 9', '─'.repeat(40)].join('\n')

it('clears a stranded prompt when the emptied composer repaints a suggestion', async () => {
  vi.useFakeTimers()
  const writes: string[] = []
  const records: string[] = []
  let killed = false
  const io = {
    sessionId: 's1',
    prompt: 'yes fix all 9',
    write: (data: string) => {
      writes.push(data)
      if (data === '\x15') killed = true
      return true
    },
    record: (event: string) => { records.push(event) },
    session: {
      snapshotScreen: () => SUGGESTION_SCREEN,
      // Our typed bytes are plain text (drafted) until the first kill; after it
      // only the dim suggestion remains (empty), as cell attributes show.
      getComposerState: () => (killed ? 'empty' as const : 'drafted' as const),
      armPromptAcceptance: () => ({ promise: new Promise(() => {}), cancel: vi.fn() }),
    },
  } as unknown as PromptDeliveryIo

  const delivery = deliverClaudePrompt(io)
  await vi.advanceTimersByTimeAsync(30_000)
  const result = await delivery
  expect(records.join(',')).toContain('rollback-cleared')
  expect(records).not.toContain('rollback-exhausted')
  expect(writes.filter(data => data === '\x15')).toHaveLength(1)
  expect(result).toMatchObject({ ok: false, promptWritten: false, retrySafe: true })
})
