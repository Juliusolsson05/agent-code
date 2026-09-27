import { afterEach, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// #1350: a delivery whose absorption timed out while Claude was busy wrote its
// bytes, could not SEE them within the rollback's observe window, and gave up
// ("composer could not be recovered"). The bytes painted 0.7-3.8 s later in all
// three recorded incidents, and the gate then read them as a human draft for
// good: every later delivery was refused as "occupied by a human draft".
// SessionManager now tells the next delivery when the composer can only hold
// our own stranded write (no other writer has touched the PTY since); that
// delivery clears it under its reservation and goes on.
afterEach(() => { vi.useRealTimers() })

const RULE = '─'.repeat(40)
const composer = (row: string) => [RULE, row, RULE].join('\n')
type Attributes = { dim: number; inverse: number; plain: number }
type Frame = { screen: string; attributes: Attributes | null }
const STRANDED: Frame = { screen: composer('❯ an earlier prompt that painted late'), attributes: { dim: 0, inverse: 1, plain: 33 } }
const EMPTY: Frame = { screen: composer('❯'), attributes: null }

function harness(opts: { strandedComposer?: boolean; killClears?: boolean }) {
  const writes: string[] = []
  const records: string[] = []
  let state: 'stranded' | 'empty' | 'prompted' = 'stranded'
  const frame = (): Frame => state === 'stranded'
    ? STRANDED
    : state === 'empty' ? EMPTY : { screen: composer('❯ send the next task'), attributes: { dim: 0, inverse: 1, plain: 19 } }
  const io = {
    sessionId: 's1',
    prompt: 'send the next task',
    ...(opts.strandedComposer ? { strandedComposer: true } : {}),
    write: (data: string) => {
      writes.push(data)
      if (data === '\x15' && opts.killClears !== false) state = 'empty'
      else if (data === '\x19') state = 'stranded'
      else if (data === 'send the next task') state = 'prompted'
      return true
    },
    record: (event: string) => { records.push(event) },
    session: {
      snapshotScreen: () => frame().screen,
      readComposer: () => frame(),
      // The gate as claudeSession derives it: any drafted composer is occupied.
      awaitReadyForPrompt: vi.fn(async () => state === 'stranded'
        ? { kind: 'occupied' as const, reason: 'human-draft' as const, waitedMs: 0 }
        : { kind: 'ready' as const, waitedMs: 0 }),
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }),
        cancel: vi.fn(),
      }),
    },
  } as unknown as PromptDeliveryIo
  return { io, writes, records }
}

it('clears our own stranded prompt under the reservation, then delivers', async () => {
  vi.useFakeTimers()
  const { io, writes, records } = harness({ strandedComposer: true })
  const delivery = deliverClaudePrompt(io)
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(delivery).resolves.toMatchObject({ ok: true })
  expect(writes).toEqual(['\x15', 'send the next task', '\r'])
  expect(records).toContain('stranded-reclaimed')
})

it('still refuses a drafted composer it cannot prove is its own', async () => {
  const { io, writes } = harness({})
  const result = await deliverClaudePrompt(io)
  expect(result).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false })
  expect(result.ok ? '' : result.message).toContain('occupied by a human draft')
  expect(writes).toEqual([])
})

it('puts the stranded prompt back and says so when it cannot clear it', async () => {
  vi.useFakeTimers()
  const { io, writes } = harness({ strandedComposer: true, killClears: false })
  const delivery = deliverClaudePrompt(io)
  await vi.advanceTimersByTimeAsync(10_000)
  const result = await delivery
  expect(result).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false, retrySafe: true })
  expect(result.ok ? '' : result.message).toContain('earlier prompt from Agent Code')
  // Bounded kills, one yank, and never the new prompt or an Enter.
  expect(writes.filter(data => data === '\x15').length).toBe(64)
  expect(writes.at(-1)).toBe('\x19')
  expect(writes).not.toContain('send the next task')
  expect(writes).not.toContain('\r')
})
