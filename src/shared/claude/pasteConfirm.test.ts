import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  activeClaudeComposerText,
  extractActiveClaudeComposer,
  imagePlaceholderCount,
  pasteAbsorbedVia,
  pasteTailNeedle,
  placeholderCount,
  pollPasteAbsorbed,
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

// wrap-ansi 7 ships no types; this is the one call signature the test needs,
// the same options Ink passes. Loaded with require because v7 is CommonJS.
const wrapAnsi = createRequire(import.meta.url)('wrap-ansi') as (
  input: string,
  columns: number,
  options: { trim: boolean; hard: boolean },
) => string

describe('inline paste tail through a HARD wrap (#1118)', () => {
  // The chrome around the composer comes from a real recorded frame
  // (testing/fixtures/image-absorption, Claude Code 2.1.278): the dividers,
  // the `❯ ` first-line prefix and the two-space continuation indent. Only the
  // composer body is re-rendered, at each width, with the wrap Claude's Ink
  // actually applies: `wrapAnsi(text, width, { trim: false, hard: true })`
  // (vendor/claude-code-src/full/ink/wrap-text.ts). Ink binds Bun.wrapAnsi when
  // it exists and the npm wrap-ansi otherwise; both honour `hard`, which is the
  // property that matters: a token longer than the line is cut mid-token.
  const fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../testing/fixtures/image-absorption/wrapped-image-pill-2026-09-21.json', import.meta.url)),
    'utf8',
  )) as { deliveries: { wrapped: { after: { screen: string } } } }
  const recorded = fixture.deliveries.wrapped.after.screen.split('\n')
  const isDivider = (line: string): boolean => /^─{10,}$/u.test(line)
  const top = recorded.findIndex(isDivider)
  const bottom = recorded.findIndex((line, i) => i > top && isDivider(line))

  function screenAt(cols: number, composerText: string): string {
    const body = composerText.length === 0
      ? ['❯']
      // Geometry calibrated against both recorded frames (#1219 review, Pi
      // F3): the prompt marker is `❯` + NO-BREAK SPACE, continuation lines
      // indent two spaces, and the body is the pane width MINUS THREE (61
      // columns in the 64-column recording). So a full composer line is one
      // column shorter than the divider. An earlier cols-2 geometry hid that.
      : wrapAnsi(composerText, cols - 3, { trim: false, hard: true })
        .split('\n')
        .map((line, i) => (i === 0 ? '❯\u00a0' : '  ') + line)
    const divider = '─'.repeat(cols)
    return [...recorded.slice(0, top), divider, ...body, divider, ...recorded.slice(bottom + 1)].join('\n')
  }

  // The issue's repro: a prompt ending in an absolute path, long enough to be
  // paste-like but too short for Claude to collapse, so the inline tail is the
  // only signal. Absorption was never detected at 14 of 81 widths.
  const prompt = 'please review /Users/juliusolsson/Desktop/Development/agent-code/src/providers/claude/runtime/promptDelivery.ts'

  it('confirms absorption at every pane width from 20 to 140 columns', () => {
    const tail = pasteTailNeedle(prompt)
    const missed: number[] = []
    for (let cols = 20; cols <= 140; cols += 1) {
      const baseline = activeClaudeComposerText(screenAt(cols, ''))
      const baseCount = placeholderCount(baseline)
      const after = activeClaudeComposerText(screenAt(cols, prompt))
      if (pasteAbsorbedVia(after, tail, baseCount, false) !== 'inline') missed.push(cols)
    }
    expect(missed).toEqual([])
  })

  // #1292 (C1 hunt): the hard-cut rule compared the previous line's STRING
  // length with the width, but a wide (CJK) character is one UTF-16 unit and
  // two cells; a real xterm row of 9 CJK characters after `❯ ` is 20 cells
  // and 11 characters long (probed with @xterm/headless). So every CJK wrap
  // was read as soft, joined with a space, and the tail never matched: a 5 s
  // timeout and a rollback for most multi-row CJK prompts. And with an odd
  // free width a wide character cannot fill the last cell, so a CJK row can
  // stop one cell short of full. That one-cell-short row is AMBIGUOUS once
  // xterm drops trailing spaces (a soft wrap can end in a wide glyph with its
  // real space in the last cell, steering q34), so it keeps the space and the
  // delivery waits out the timeout. The sweeps therefore run over the widths
  // whose body (cols - 3) is EVEN, where wide rows fill completely; the odd
  // ones are pinned below as a timeout, never a false confirmation.
  const cjkPrompt = '请检查这个问题并修复所有相关的测试然后运行完整的测试套件确认没有回归再提交拉取请求并通知审查人员继续推进后续工作'
  // Pane widths whose composer body (cols - 3) is even: a run of two-cell
  // glyphs fills every row to the last cell, so each cut is a full row.
  const evenBodyWidths = Array.from({ length: 121 }, (_, i) => 20 + i).filter(cols => (cols - 3) % 2 === 0)
  const oddBodyWidths = Array.from({ length: 121 }, (_, i) => 20 + i).filter(cols => (cols - 3) % 2 === 1)

  it('confirms a wrapped CJK prompt at every pane width whose rows fill', () => {
    const tail = pasteTailNeedle(cjkPrompt)
    const missed: number[] = []
    for (const cols of evenBodyWidths) {
      const baseline = activeClaudeComposerText(screenAt(cols, ''))
      const after = activeClaudeComposerText(screenAt(cols, cjkPrompt))
      if (pasteAbsorbedVia(after, tail, placeholderCount(baseline), false) !== 'inline') missed.push(cols)
    }
    expect(missed).toEqual([])
  })

  it('confirms a wrapped mixed Latin and CJK prompt ending in a path', () => {
    const mixed = `${cjkPrompt} /Users/example/project/src/providers/claude/runtime/promptDelivery.ts`
    const tail = pasteTailNeedle(mixed)
    const missed: number[] = []
    for (const cols of evenBodyWidths) {
      if (pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, mixed)), tail, 0, false) !== 'inline') missed.push(cols)
    }
    expect(missed).toEqual([])
  })

  // #1310 review: symbols the owner actually types are two cells wide too.
  it.each([
    ['check marks', '✅'.repeat(40)],
    ['crosses', '❌'.repeat(30)],
    ['rockets', '🚀'.repeat(60)],
    ['fullwidth punctuation', '︐'.repeat(101)],
    ['check marks before a path', `${'✅'.repeat(40)} /Users/example/project/src/providers/claude/runtime/promptDelivery.ts`],
    // #1310 final review C: a flag is one cluster of two regional
    // indicators, two cells; it was measured as one.
    ['a flag before a path', `done ${'🇸🇪'.repeat(30)} /Users/example/project/src/providers/claude/runtime/promptDelivery.ts`],
  ])('confirms wrapped %s at every width whose rows fill', (_name, prompt) => {
    const tail = pasteTailNeedle(prompt)
    const missed: number[] = []
    for (const cols of evenBodyWidths) {
      if (pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, prompt)), tail, 0, false) !== 'inline') missed.push(cols)
    }
    expect(missed).toEqual([])
  })

  // The known residual (#1292 stays open for it): with an odd body width a
  // wide-glyph row stops one cell short and is read as a soft wrap. The
  // delivery then times out and rolls back; it must NEVER confirm.
  it('times out rather than confirms when wide rows stop one cell short', () => {
    const tail = pasteTailNeedle(cjkPrompt)
    const missed: number[] = []
    for (const cols of oddBodyWidths) {
      const result = pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, cjkPrompt)), tail, 0, false)
      // Anything but a miss or a true inline match would be a false signal.
      expect([null, 'inline']).toContain(result)
      if (result === null) missed.push(cols)
    }
    // Measured on this head. The widths between 60 and 68 confirm because the
    // tail needle sits wholly after the last one-short cut. A fix that shrinks
    // this list is welcome; update the pin. Growing it is a regression.
    expect(missed).toEqual([
      20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58,
      70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114,
    ])
  })

  // #1310 review A/B: a SOFT wrap before a wide word must keep its space. A
  // join without it confirmed a paste whose tail had not arrived (B's probe:
  // an early Enter on a partial screen).
  it('never confirms early across a soft wrap before a wide character', () => {
    const payload = 'abcdefghijklmnop 请ghijklm\nabcdefghijklmnop请ghijklm'
    const tail = pasteTailNeedle(payload)
    for (let cols = 20; cols <= 140; cols += 1) {
      const partial = activeClaudeComposerText(screenAt(cols, 'abcdefghijklmnop 请ghijklm'))
      expect(pasteAbsorbedVia(partial, tail, 0, false)).toBeNull()
    }
  })

  // Steering q33: a ZWJ emoji is ONE grapheme and two cells (Ink's
  // string-width measures clusters). Counting its code points made a soft
  // wrap look full, dropped the real space, and confirmed a different paste.
  it('never confirms early across a soft wrap after a ZWJ emoji run', () => {
    const shown = `${'👩‍💻'.repeat(5)} abcdefgh`
    const other = `${'👩‍💻'.repeat(5)}abcdefgh`
    for (let cols = 20; cols <= 40; cols += 1) {
      expect(pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, shown)), pasteTailNeedle(other), 0, false)).toBeNull()
    }
  })

  // Only a variation-selector emoji is swept positively. npm wrap-ansi 7
  // (hard: true) splits ZWJ and skin-tone sequences mid-cluster across rows;
  // Claude runs on Bun, whose Ink uses Bun.wrapAnsi, and how THAT splits a
  // cluster is unknown without a recorded frame. A missed confirmation there
  // is a timeout, the safe direction; the early-confirmation case above is
  // the one that must hold, and does.
  it('confirms a wrapped run of variation-selector emoji', () => {
    for (const prompt of ['❤️'.repeat(40)]) {
      const tail = pasteTailNeedle(prompt)
      const missed: number[] = []
      for (let cols = 20; cols <= 140; cols += 1) {
        if (pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, prompt)), tail, 0, false) !== 'inline') missed.push(cols)
      }
      expect(missed).toEqual([])
    }
  })

  // Steering q34: a soft wrap can END in a wide glyph too, with its real
  // space in the last cell; xterm drops that space, so a one-cell-short row is
  // ambiguous. Joining it confirmed a paste that had not landed.
  it('never confirms early across a soft wrap after a CJK run', () => {
    const shown = `${'你'.repeat(8)} 好abcdefgh`
    const absent = `${'你'.repeat(8)}好abcdefgh`
    for (let cols = 20; cols <= 40; cols += 1) {
      expect(pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, shown)), pasteTailNeedle(absent), 0, false)).toBeNull()
    }
  })

  // #1310 final review (A, C): an OVERcounted width is the unsafe direction.
  // It makes a soft-wrapped row look full, the join drops the real space, and
  // a different paste confirms. Each of these is one cell wide to Ink and
  // xterm but was measured as more: a text-presentation pictograph with no
  // VS16 (🌡 U+1F321, 🗓 U+1F5D3, both East Asian Width N) and a zero-width
  // space (U+200B, 405 of them in the owner's typed prompts).
  it.each([
    ['a text-presentation thermometer', '🌡'.repeat(10)],
    ['a text-presentation calendar', `abcdefghijklmno🗓`],
  ])('never confirms early across a soft wrap after %s', (_name, run) => {
    const shown = `${run} XXXXZZZZ`
    const absent = `${run}XXXXZZZZ`
    for (let cols = 20; cols <= 40; cols += 1) {
      expect(pasteAbsorbedVia(activeClaudeComposerText(screenAt(cols, shown)), pasteTailNeedle(absent), 0, false)).toBeNull()
    }
  })

  // The zero-width space needs rows built as Ink wraps them: the npm
  // wrap-ansi in this harness counts U+200B as a cell, which hides the case.
  // Here the first row's glyphs leave exactly one cell, the soft-wrap space
  // (dropped by xterm) sat in it, and the ZWSP adds nothing.
  it('never confirms early across a soft wrap after a zero-width space', () => {
    for (const cols of [20, 64, 80, 120]) {
      const body = cols - 3
      const first = `${'a'.repeat(body - 1)}\u200b`
      const screen = [
        ...recorded.slice(0, top), '─'.repeat(cols),
        `❯\u00a0${first}`, '  XXXXZZZZ',
        '─'.repeat(cols), ...recorded.slice(bottom + 1),
      ].join('\n')
      expect(pasteAbsorbedVia(activeClaudeComposerText(screen), pasteTailNeedle(`${first}XXXXZZZZ`), 0, false)).toBeNull()
    }
  })

  it('keeps the space of a soft wrap between a long word and a CJK word', () => {
    const prompt = `${'a'.repeat(101)} 你好吗`
    expect(activeClaudeComposerText(screenAt(20, prompt))).toContain(' 你好吗')
  })

  it('still refuses a composer that holds only the start of the prompt', () => {
    // The tail is what proves the WHOLE paste landed. A composer still
    // receiving the paste shows its head, and must not confirm.
    const tail = pasteTailNeedle(prompt)
    for (const cols of [48, 94]) {
      const partial = activeClaudeComposerText(screenAt(cols, prompt.slice(0, prompt.length - 30)))
      expect(pasteAbsorbedVia(partial, tail, 0, false)).toBeNull()
    }
  })

  it('does not confirm a paste whose whitespace the composer does not show', () => {
    // Review round 1 (A): a wrap only ever ADDS whitespace. The withdrawn
    // strip-everything cut also accepted MISSING whitespace, so `foo\nbar`
    // "landed" on a composer showing `foobar` and Enter was sent.
    const tail = pasteTailNeedle('foo\nbar')
    expect(pasteAbsorbedVia(activeClaudeComposerText(screenAt(80, 'foobar')), tail, 0, false)).toBeNull()
    expect(pasteAbsorbedVia(activeClaudeComposerText(screenAt(80, 'foo bar')), tail, 0, false)).toBe('inline')
  })

  it('does not confirm a pending paste on an unrelated recorded composer', () => {
    // Review round 1 (A), built from the recorded pair itself: the composer
    // shows `… opencode [Image` / `  #1]` for a DIFFERENT prompt, while the
    // pending payload is `opencode[\nImage#1]`. Stripped, the two were equal.
    const recordedAfter = activeClaudeComposerText(fixture.deliveries.wrapped.after.screen)
    const tail = pasteTailNeedle('opencode[\nImage#1]')
    expect(pasteAbsorbedVia(recordedAfter, tail, 0, false)).toBeNull()
  })

  it('does not confirm a second paste on a hard-wrapped tail that was already there', async () => {
    // Review round 1 (B): the composer already holds this payload's tail,
    // hard-wrapped. The baseline must recognise it despite the wrap, or an
    // unchanged screen confirms the new paste before it lands.
    const already = screenAt(48, prompt)
    const outcome = await pollPasteAbsorbed(() => already, already, prompt, { timeoutMs: 30, pollIntervalMs: 5 })
    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('does not confirm on an earlier part of the paste that has a space the tail lacks', () => {
    // Review round 2 (A): the payload's first line `abcdefghijkl mnopqrstuvwx`
    // has painted, and its real tail `abcdefghijklmnopqrstuvwx` has not. A
    // matcher that let whitespace appear anywhere confirmed here and sent
    // Enter before the tail arrived.
    const t = 'abcdefghijklmnopqrstuvwx'
    const tail = pasteTailNeedle(`abcdefghijkl mnopqrstuvwx\n${t}`)
    const partial = activeClaudeComposerText(screenAt(80, 'abcdefghijkl mnopqrstuvwx'))
    expect(pasteAbsorbedVia(partial, tail, 0, false)).toBeNull()
  })

  it('does not read a soft-wrapped recorded pill as a tail without its space', () => {
    // Review round 2 (A), on the recorded frame: `[Image` / `  #1]` is a soft
    // wrap of `[Image #1]`, not `Image#1`.
    const recorded = activeClaudeComposerText(fixture.deliveries.wrapped.after.screen)
    expect(recorded).toContain('[Image #1]')
    expect(pasteAbsorbedVia(recorded, pasteTailNeedle('Image#1\n'), 0, false)).toBeNull()
  })
})
