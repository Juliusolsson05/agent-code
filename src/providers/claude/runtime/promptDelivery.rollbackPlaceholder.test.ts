import { afterEach, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// #1291: the paste-debug journals hold 4 `rollback-exhausted {presses: 64}`
// against 1 `rollback-cleared`. After absorption timed out, the rollback read
// the composer TEXT-ONLY, and Claude repaints placeholder text (a prompt
// suggestion such as the recorded "yes fix all 9", or a hint) into an emptied
// composer; text-only reads that as a draft, so every kill looked like it
// failed and 64 presses later the prompt was yanked back and stranded.
// #1309 review: the fix must read the LIVE buffer (not the lagging per-frame
// cache) and must not call a leftover inverse-cursor character "empty".
afterEach(() => { vi.useRealTimers() })

const RULE = '─'.repeat(40)
const composer = (row: string) => [RULE, row, RULE].join('\n')
type Attributes = { dim: number; inverse: number; plain: number }
type Frame = { screen: string; attributes: Attributes | null }

// Our bytes, as typed (plain cells).
const TYPED: Frame = { screen: composer('❯ yes fix all 9'), attributes: { dim: 0, inverse: 1, plain: 12 } }

async function rollback(afterKill: Frame, before: Frame = TYPED) {
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
      // The same frame is visible before our write too, so absorption never
      // sees a transition and the delivery reaches the rollback (#1230).
      snapshotScreen: () => (killed ? afterKill : before).screen,
      readComposer: () => (killed ? afterKill : before),
      armPromptAcceptance: () => ({ promise: new Promise(() => {}), cancel: vi.fn() }),
    },
  } as unknown as PromptDeliveryIo
  const delivery = deliverClaudePrompt(io)
  await vi.advanceTimersByTimeAsync(30_000)
  const result = await delivery
  return { result, records, kills: writes.filter(data => data === '\x15').length }
}

it('clears a stranded prompt when the emptied composer repaints a dim suggestion', async () => {
  // After the kill only the suggestion remains: dim text, the cursor on its
  // first cell, nothing typed.
  const { result, records, kills } = await rollback({ screen: composer('❯ yes fix all 9'), attributes: { dim: 12, inverse: 1, plain: 0 } })
  expect(records.join(',')).toContain('rollback-cleared')
  expect(kills).toBe(1)
  expect(result).toMatchObject({ ok: false, promptWritten: false, retrySafe: true })
})

it('does not call a leftover character under the cursor empty', async () => {
  // A partial kill: one real character remains, drawn inverse (the cursor on
  // it), no dim placeholder. Attributes alone would say "nothing typed".
  const { records } = await rollback({ screen: composer('❯ y'), attributes: { dim: 0, inverse: 1, plain: 0 } })
  expect(records.join(',')).not.toContain('rollback-cleared')
})

it('trusts a bare prompt marker even when attributes are unavailable', async () => {
  // The emptied composer shows only the marker; this is the text read's own
  // reliable "empty", independent of any attribute or cache timing.
  const { records, kills } = await rollback({ screen: composer('❯'), attributes: null })
  expect(records.join(',')).toContain('rollback-cleared')
  expect(kills).toBe(1)
})
