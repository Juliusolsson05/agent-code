// #1113: a word-wrapped `[Image #N]` pill stalls image delivery.
//
// WHY this is a recorded test and not a screen literal: the bug only exists
// because a REAL terminal reflowed the composer. Anybody writing a fake screen
// puts `[Image #1]` on one line, which is exactly the case that always worked —
// the literal would have passed against the broken detector. So the input here
// is two real baseline/after pairs lifted out of the debug bundle the owner
// captured while the send was failing (see the fixture README), and the test
// drives `deliverClaudePrompt`, the actual main-process entry point, rather
// than the detector in isolation. The detector's own unit coverage lives in
// @shared/claude/pasteConfirm.test.ts; this file is here to prove the bug is
// gone on the path a user's Enter actually travels.
//
// Only true edges are stubbed: the PTY write sink and the acceptance observer
// (which reads Claude's JSONL, not the screen). Everything between the call and
// the absorption decision is production code.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

type RecordedFrame = { seq: number; tsIso: string; screenHash: string; screen: string }
type RecordedDelivery = {
  outcome: string
  imageCount: number
  submitBeginIso: string
  baseline: RecordedFrame
  after: RecordedFrame
}

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../testing/fixtures/image-absorption/wrapped-image-pill-2026-09-21.json',
    ),
    'utf8',
  ),
) as { deliveries: Record<'wrapped' | 'unwrapped', RecordedDelivery> }

// Delivery observes THREE composer states, and the recording only sampled two
// of them: the screen sampler stores distinct hashes, and the moment between
// "text landed" and "pill landed" never produced a stored sample. It is
// reconstructed here by deleting the recorded pill from the recorded `after`
// frame — which is faithful precisely because Claude appends the pill at the
// very end of the composer, so removing it cannot change how the text before it
// wrapped.
//
// Reconstructing it is REQUIRED, but not for the reason an earlier version of
// this comment gave (review R1-F3, checked by actually doing it): replaying
// `after` for both phases does not make these tests pass vacuously — it makes
// them FAIL, because the baseline then counts one pill and the poll waits
// forever for `1 >= 1 + 1`. The reason it is needed is the second test, whose
// paste-like prompt must find its own text on screen, without the pill, before
// the image paste is written.
function withoutPill(screen: string): string {
  const stripped = screen.replace(/\s*\[Image\s*#\d+\]/gu, '')
  if (stripped === screen) throw new Error('fixture frame has no image pill to strip')
  return stripped
}

/**
 * Replay one recorded delivery against the real state machine.
 *
 * Enter is what we are measuring, so the acceptance observer resolves
 * immediately; the question this test asks is whether we ever get far enough to
 * write `\r` at all.
 */
function replay(delivery: RecordedDelivery, prompt: string): {
  io: PromptDeliveryIo
  writes: string[]
} {
  const writes: string[] = []
  let textWritten = false
  let imagePathsWritten = false
  const io = {
    sessionId: 'recorded',
    prompt,
    imagePaths: Array.from(
      { length: delivery.imageCount },
      (_, i) => `/tmp/agent-code/recorded-${i}.png`,
    ),
    write: (data: string) => {
      writes.push(data)
      if (data.includes('.png')) imagePathsWritten = true
      else if (data.includes(prompt.slice(-24))) textWritten = true
      return true
    },
    session: {
      snapshotScreen: () => {
        if (imagePathsWritten) return delivery.after.screen
        if (textWritten) return withoutPill(delivery.after.screen)
        return delivery.baseline.screen
      },
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }),
        cancel: vi.fn(),
      }),
    },
  } as unknown as PromptDeliveryIo
  return { io, writes }
}

// Longer than the 5 s absorption budget inside promptDelivery. With the default
// 5 s vitest timeout a regression reports "Test timed out", hiding the
// `absorption-timeout` result that names the actual defect; a healthy delivery
// still returns in tens of milliseconds, so this costs nothing when passing.
const TEST_TIMEOUT_MS = 20_000

describe('recorded image delivery (#1113)', () => {
  it('submits when the TUI wrapped the image pill across the composer edge', async () => {
    const delivery = fixture.deliveries.wrapped
    // Guards the fixture, not the code: if a future recording no longer wraps,
    // this test silently stops covering the bug it was written for.
    expect(delivery.after.screen).toContain('[Image\n')
    const { io, writes } = replay(
      delivery,
      'Lets figure out why this is happening wiht opencode',
    )

    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(writes.at(-1)).toBe('\r')
  }, TEST_TIMEOUT_MS)

  it('still submits when the pill fits on one line', async () => {
    const delivery = fixture.deliveries.unwrapped
    expect(delivery.after.screen).toContain('[Image #2]')
    const { io, writes } = replay(
      delivery,
      'Not only that ,t he send mechanic is now broken on claude... we for sure need to figure that out with integration tests.',
    )

    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(writes.at(-1)).toBe('\r')
  }, TEST_TIMEOUT_MS)
})
