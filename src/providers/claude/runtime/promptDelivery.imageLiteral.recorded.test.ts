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

import { afterEach, describe, expect, it, vi } from 'vitest'

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

// The #1226 review found the new text wait had two holes that nothing
// covered: a prompt with no visible text can never confirm, and the
// timeout/rollback branch the wait makes reachable for EVERY short image
// prompt had zero tests (deleting it outright left the suite green). These
// drive the same recorded frame through each shape.

/** A scripted screen: `frameFor` sees every write so far and picks the frame. */
function scripted(prompt: string, frameFor: (writes: string[]) => string): {
  io: PromptDeliveryIo; writes: string[]
} {
  const writes: string[] = []
  const io = {
    sessionId: 'recorded',
    prompt,
    imagePaths: ['/tmp/agent-code/recorded-0.png'],
    write: (data: string) => { writes.push(data); return true },
    session: {
      snapshotScreen: () => frameFor(writes),
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }),
        cancel: vi.fn(),
      }),
    },
  } as unknown as PromptDeliveryIo
  return { io, writes }
}

const idle = (): string => fixture.deliveries.wrapped.baseline.screen

describe('short image prompts around the text wait (#1226 review)', () => {
  it('delivers a whitespace-only prompt with an image instead of timing out', async () => {
    // A lone space has nothing to see, so a wait on it could only time out,
    // and the rollback cannot see it either: the send used to end in a
    // permanent do-not-retry. main delivered this shape; so must we.
    const { io, writes } = scripted(' ', w =>
      w.some(d => d.includes('.png')) ? frameShowing('[Image #1]') : idle())
    const started = Date.now()
    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    // No 5 s wait was burned before the image went in.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(writes[0]).toBe(' ')
    expect(writes.at(-1)).toBe('\r')
  }, 20_000)

  it('writes no second separator after a prompt that already ends in whitespace', async () => {
    const prompt = 'fix this '
    const { io, writes } = scripted(prompt, w => {
      if (w.some(d => d.includes('.png'))) return frameShowing('fix this [Image #1]')
      return w.includes(prompt) ? frameShowing('fix this') : idle()
    })
    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    // Raw text (not bracketed), then the image paste directly, then Enter.
    expect(writes).toHaveLength(3)
    expect(writes[0]).toBe(prompt)
    expect(writes[1]).toContain('/tmp/agent-code/recorded-0.png')
    expect(writes[2]).toBe('\r')
  }, 20_000)

  describe('when the text never fully paints', () => {
    afterEach(() => { vi.useRealTimers() })

    it('rolls the text back and reports a safe retry, with no image and no Enter', async () => {
      // The composer shows only part of the text, so the tail never appears
      // and the wait times out, but the bytes are visibly ours. Rollback
      // must kill them and the result must say "not sent, safe to retry":
      // the goal loop, MCP and the renderer all branch on that disposition.
      vi.useFakeTimers()
      const { io, writes } = scripted('fix this', w =>
        w.includes('\x15') ? idle() : w.includes('fix this') ? frameShowing('fix th') : idle())
      const delivery = deliverClaudePrompt(io)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(delivery).resolves.toMatchObject({
        ok: false,
        stage: 'absorption',
        code: 'absorption-timeout',
        retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false,
        enterWritten: false,
      })
      expect(writes).toContain('\x15')
      expect(writes.some(d => d.includes('.png'))).toBe(false)
      expect(writes).not.toContain('\r')
    })
  })
})
