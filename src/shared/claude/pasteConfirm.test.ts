import { describe, expect, it } from 'vitest'

import {
  extractActiveClaudeComposer,
  imagePlaceholderCount,
  pasteAbsorbedVia,
  placeholderCount,
} from './pasteConfirm.js'
import { isPasteLike } from './pasteConfirm.js'

describe('Claude active composer extraction', () => {
  it('excludes matching text and placeholders from transcript scrollback', () => {
    const screen = [
      '❯ old duplicated tail',
      '[Pasted text #7]',
      'assistant response',
      '❯ current draft',
      '────────────────────────',
      'status bar',
    ].join('\n')
    const composer = extractActiveClaudeComposer(screen)

    expect(composer).toBe('❯ current draft')
    expect(pasteAbsorbedVia(composer, 'old duplicated tail', 0, false)).toBeNull()
  })

  it('does not interpret prompt-owned ASCII dividers as Claude chrome', () => {
    const screen = ['❯ first line', '--------', 'tail after divider', '────────────'].join('\n')
    expect(extractActiveClaudeComposer(screen)).toBe(
      ['❯ first line', '--------', 'tail after divider'].join('\n'),
    )
  })

  it('routes bare carriage returns through bracketed paste', () => {
    expect(isPasteLike('first\rsecond')).toBe(true)
  })

  it('does not rebase on a quoted prompt marker inside the active composer', () => {
    const screen = [
      'assistant history',
      '────────────────────',
      '❯ explain this quote',
      '❯ quoted Claude output',
      'tail of my prompt',
      '────────────────────',
      'status',
    ].join('\n')
    expect(extractActiveClaudeComposer(screen)).toBe([
      '❯ explain this quote',
      '❯ quoted Claude output',
      'tail of my prompt',
    ].join('\n'))
  })
})

describe('Claude image placeholder counting', () => {
  // #1113. `[Image #1]` carries exactly one internal space, which is the only
  // point a word wrap can break it, so the pill routinely arrives split across
  // two composer lines. The literal `/\[Image #\d+\]/` this used to be matched
  // neither half, `pollClaudeImagesAbsorbed` never saw its count rise, and
  // every image prompt at that pane width died as `absorption-timeout` with the
  // draft stranded in the composer. Recorded frames for the same failure drive
  // providers/claude/runtime/promptDelivery.imageWrap.recorded.test.ts.
  it('counts a pill the TUI wrapped across the composer edge', () => {
    const composer = ['❯ Lets figure out why this is happening wiht opencode [Image', '  #1]'].join('\n')
    expect(imagePlaceholderCount(composer)).toBe(1)
  })

  it('counts an unwrapped pill exactly once', () => {
    expect(imagePlaceholderCount('❯ look at this [Image #1]')).toBe(1)
  })

  it('counts each pill when several wrap independently', () => {
    const composer = [
      '❯ compare these two screenshots [Image',
      '  #1] and [Image',
      '  #2] please',
    ].join('\n')
    expect(imagePlaceholderCount(composer)).toBe(2)
  })

  // The count is only ever read as a DELTA against a baseline, but it must
  // still not invent pills: a bare `[Image` with no index is Claude rendering
  // something else, and treating it as a pill would let Enter fire before the
  // attachment existed — the exact race the confirm protocol exists to prevent.
  it('does not count a truncated pill that has no index', () => {
    expect(imagePlaceholderCount('❯ a literal [Image marker')).toBe(0)
    expect(imagePlaceholderCount('❯ a literal [Image\n  marker]')).toBe(0)
  })
})

describe('Claude collapsed-paste placeholder counting', () => {
  // The image pill's sibling (#1113). This one has two internal spaces, so a
  // wrap has two places to hide it, and there is no inline-tail fallback for a
  // paste Claude has collapsed — a missed placeholder is a guaranteed
  // absorption timeout with the draft left in the composer.
  it('counts a placeholder wrapped at either of its two spaces', () => {
    expect(placeholderCount('❯ here is the log [Pasted\n  text #1 +42 lines]')).toBe(1)
    expect(placeholderCount('❯ here is the log [Pasted text\n  #1 +42 lines]')).toBe(1)
  })

  it('still counts each placeholder separately when two are present', () => {
    expect(placeholderCount('❯ [Pasted text #1] then [Pasted\n  text #2]')).toBe(2)
  })

  it('does not count prompt prose that merely mentions a paste', () => {
    expect(placeholderCount('❯ explain what [Pasted text means')).toBe(0)
  })
})
