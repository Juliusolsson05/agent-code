// #1119: a SHORT prompt that literally contains `[Image #N]` confirmed image
// absorption before any attachment rendered, and Enter went out without the
// image.
//
// The mechanism, from promptDelivery.ts: a short (non-paste-like) prompt was
// written raw with no absorption wait, and the image baseline was sampled
// right after that write, before the text had repainted. When the text then
// painted, its own literal `[Image #1]` raised the placeholder count past the
// baseline and the image poll "saw" the pill it was waiting for.
//
// The frames are the real recorded Claude Code 2.1.278 composer from the
// #1113 fixture: its idle baseline, and its composer line carrying this test's
// prompt. The lag is modelled the way the issue describes it: the first screen
// sample after the text write still shows the old composer.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../testing/fixtures/image-absorption/wrapped-image-pill-2026-09-21.json'),
  'utf8',
)) as { deliveries: { wrapped: { baseline: { screen: string }; after: { screen: string } } } }

const PROMPT = 'why does [Image #1] look wrong'

/** The recorded frame with its composer line replaced by `composerText`. */
function frameShowing(composerText: string): string {
  const lines = fixture.deliveries.wrapped.baseline.screen.split('\n')
  const prompt = lines.findIndex(line => line.startsWith('❯'))
  if (prompt < 0) throw new Error('fixture frame has no composer line')
  lines[prompt] = `❯ ${composerText}`
  return lines.join('\n')
}

function replay(pillRenders = false): { io: PromptDeliveryIo; writes: string[] } {
  const writes: string[] = []
  let textWritten = false
  let samplesSinceText = 0
  let imagePathsWritten = false
  const io = {
    sessionId: 'recorded',
    prompt: PROMPT,
    imagePaths: ['/tmp/agent-code/recorded-0.png'],
    write: (data: string) => {
      writes.push(data)
      if (data.includes(PROMPT)) textWritten = true
      if (data.includes('.png')) imagePathsWritten = true
      return true
    },
    session: {
      snapshotScreen: () => {
        if (!textWritten) return fixture.deliveries.wrapped.baseline.screen
        // The first sample after the write predates the repaint.
        samplesSinceText += 1
        if (samplesSinceText === 1) return fixture.deliveries.wrapped.baseline.screen
        // From then on the text shows, literal `[Image #1]` included. In the
        // defect case the real attachment pill NEVER renders.
        if (pillRenders && imagePathsWritten) return frameShowing(`${PROMPT} [Image #2]`)
        return frameShowing(PROMPT)
      },
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }),
        cancel: vi.fn(),
      }),
    },
  } as unknown as PromptDeliveryIo
  return { io, writes }
}

describe('a short image prompt that names an image in its text (#1119)', () => {
  it('does not send Enter when no attachment ever rendered', async () => {
    const { io, writes } = replay()
    const result = await deliverClaudePrompt(io)
    expect(writes).not.toContain('\r')
    expect(result).toMatchObject({ ok: false })
  }, 20_000)

  it('still submits once the real attachment pill renders after the literal', async () => {
    // The fix must not pass by refusing every prompt that names an image: the
    // literal is in the baseline, and the real pill moves the count past it.
    const { io, writes } = replay(true)
    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(writes.at(-1)).toBe('\r')
  }, 20_000)
})
