import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import type { ConversationContent } from 'agent-transcript-parser'

// ---------------------------------------------------------------------------
// #1059, Rewind. `draft()` is the REAL entry point for both halves of this
// surface: `listPrompts` builds every picker row from it, and the renderer
// prefills the rewound session's composer with the same `promptText`
// (workspace/hook/actions/provider.ts).
//
// So leaving Claude's paste envelope on did two things: it showed the user
// `<pasted_content id="…">` in the picker, and — the one that matters — it
// RE-SENT the envelope when they rewound and pressed enter, which makes Claude
// wrap the already-wrapped text.
//
// Input is the real recorded envelope (the owner's own pasted prompt), so the
// repeated closing id is the real shape and not a guess.
// ---------------------------------------------------------------------------

const RECORDED = (JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../testing/fixtures/prompt-acceptance/pasted-typed-prompt-2026-09-20.json'),
    'utf8',
  ),
) as { transcriptEntry: { message: { content: string } } }).transcriptEntry.message.content

const WROTE =
  'Add to the list of things to resolve pre launch that the phone menu is compoletley fucekd up for remote control, it is flashing swithcing positions for the agent index like a million times.'

const text = (value: string): ConversationContent[] => [{ kind: 'text', text: value } as ConversationContent]

describe('Rewind draft and Claude\'s paste envelope (#1059)', () => {
  const claude = getHostTranscriptAdapter('claude')

  it('gives the picker row and the composer prefill the user\'s words', () => {
    expect(RECORDED).toContain('<pasted_content id="cade">')
    const draft = claude.draft(text(RECORDED))
    expect(draft.promptText).toBe(WROTE)
    expect(draft.promptText).not.toContain('pasted_content')
    expect(draft.promptMode).toBe('prompt')
  })

  // ── THESE TWO TESTS USED TO ASSERT THE #930 BUG ──
  // They pinned a PASTED `<command-name>`/`<bash-input>` as a real command,
  // and their own comment admitted why: `extractTagBody` was unanchored, so
  // "this held before the unwrap was added too". That was incidental
  // behaviour being mistaken for a requirement.
  //
  // It is not one. Claude Code writes `<bash-input>` around what the user
  // TYPED, at the top level of the message; it never puts one inside a paste
  // envelope. An envelope containing that markup means the user pasted the
  // text of a wrapper — and arming the composer to EXECUTE it is precisely
  // the harm #930 is about. Typing `!` and then pasting produces the opposite
  // nesting (envelope inside wrapper), which is covered below and in
  // rewindLiteralMarkup.test.ts.
  it('treats a pasted slash command as the text that was pasted', () => {
    const command = '<pasted_content id="x">\n<command-name>/compact</command-name>\n<command-args>keep the plan</command-args>\n</pasted_content id="x">'
    const draft = claude.draft(text(command))
    expect(draft.promptText).toBe('<command-name>/compact</command-name>\n<command-args>keep the plan</command-args>')
    expect(draft.promptMode).toBe('prompt')
  })

  it('treats a pasted bash wrapper as the text that was pasted', () => {
    const bash = '<pasted_content id="x">\n<bash-input>npm run build</bash-input>\n</pasted_content id="x">'
    const draft = claude.draft(text(bash))
    expect(draft.promptText).toBe('<bash-input>npm run build</bash-input>')
    expect(draft.promptMode).toBe('prompt')
  })

  it('unwraps a paste made inside a real bash entry', () => {
    // The nesting that DOES mean bash mode: the wrapper opens the message and
    // the envelope is inside it. The composer is prefilled with the command.
    const draft = claude.draft(text('<bash-input><pasted_content id="x">\nnpm run build\n</pasted_content id="x"></bash-input>'))
    expect(draft.promptText).toBe('npm run build')
    expect(draft.promptMode).toBe('bash')
  })

  it('leaves an ordinary prompt alone', () => {
    expect(claude.draft(text('just fix the loader')).promptText).toBe('just fix the loader')
  })

  it('leaves an ambiguous envelope wrapped rather than guessing', () => {
    // Two sibling blocks sharing an id: the shared unwrapper refuses, so the
    // draft keeps the raw text instead of inventing a boundary.
    const siblings = '<pasted_content id="x">\na\n</pasted_content id="x"><pasted_content id="x">\nb\n</pasted_content id="x">'
    expect(claude.draft(text(siblings)).promptText).toBe(siblings)
  })
})
