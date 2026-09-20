import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #930. `<bash-input>` and `<command-name>` are Claude Code's record of HOW a
// turn was entered, not content, and the Rewind draft ACTS on them: it sets
// the composer's mode and throws away everything outside the tag.
//
// The old check was `extractTagBody`, whose regex is unanchored, so a prompt
// that merely MENTIONED the markup was read as the real thing:
//
//   "How do I use <bash-input>ls</bash-input> in Claude Code?"
//     → promptText 'ls', promptMode 'bash'
//
// Rewind to that prompt and press enter and you RUN a command you were only
// ever asking about, with the question that framed it gone.
//
// Everything below runs through the REAL decoder on a REAL transcript file:
// `listPrompts` reads the bytes off disk, classifies and decodes them with
// agent-transcript-parser, and builds every picker row through the same
// `draft()` the renderer prefills the composer from. Only the SESSION-FILE
// LOOKUP is stubbed — that is a path on the real user's disk, and the one
// thing a test cannot supply.
// ---------------------------------------------------------------------------

const FIXTURE = resolve(__dirname, '../../../testing/fixtures/rewind-literal-markup/claude-wrappers-2026-09-20.jsonl')

vi.mock('@main/providerSwitch/shared.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@main/providerSwitch/shared.js')
  return { ...actual, getClaudeSessionFilePath: async () => FIXTURE }
})

const { getHostTranscriptAdapter } = await import('./transcriptEngine.js')
const claude = getHostTranscriptAdapter('claude')

/** Every picker row, in document order — `listPrompts` returns the analyzer's
 *  order and `rewindSession` is what reverses it for the picker. */
async function rows(): Promise<string[]> {
  const prompts = await claude.listPrompts('/fixture/project', 'ignored')
  return prompts.map(prompt => prompt.text)
}

/** The decoded content of the user turn whose text contains `needle`, straight
 *  from the parser — so the draft is fed exactly what production feeds it. */
async function decodedPrompt(needle: string) {
  const document = await claude.readAt!(FIXTURE)
  const entry = document.entries.find(candidate => (
    candidate.kind === 'message'
    && candidate.role === 'user'
    && candidate.content.some(item => item.kind === 'text' && item.text.includes(needle))
  ))
  if (!entry || entry.kind !== 'message') throw new Error(`no decoded user turn containing ${needle}`)
  return claude.draft(entry.content)
}

describe('a prompt that only MENTIONS a wrapper keeps its words (#930)', () => {
  it('does not arm the composer to execute a command the user asked about', async () => {
    const draft = await decodedPrompt('How do I use')
    // The whole question survives — including the tag, because that is what
    // the user wrote.
    expect(draft.promptText).toBe(
      'How do I use <bash-input>ls</bash-input> in Claude Code? I keep seeing it in transcripts.',
    )
    // The mode is the part that could have run something.
    expect(draft.promptMode).toBe('prompt')
  })

  it('does not reduce a question about /compact to the command itself', async () => {
    const draft = await decodedPrompt('get written into the transcript')
    expect(draft.promptText).toBe(
      'Does <command-name>/compact</command-name> get written into the transcript too, and what about <command-args>?',
    )
  })

  it('keeps a prompt that is ONLY context markup instead of dropping it', async () => {
    // Stripping it empties the draft, and `promptsFromSnapshot` discards a
    // prompt with no text and no images — so the turn vanished from the
    // picker and could not be rewound to at all.
    expect(await rows()).toContain(
      '<system-reminder>what does this mean when it shows up in my own prompt?</system-reminder>',
    )
  })
})

describe('a genuine wrapper is still believed', () => {
  it('reads the recorded /model command, args included', async () => {
    // Verbatim from a real 2.1.247 transcript, interior whitespace and all.
    const draft = await decodedPrompt('<command-name>/model')
    expect(draft.promptText).toBe('/model claude-fable-5')
    expect(draft.promptMode).toBe('prompt')
  })

  it('reads a bash turn as bash', async () => {
    const draft = await decodedPrompt('<bash-input>npm run build')
    expect(draft.promptText).toBe('npm run build')
    expect(draft.promptMode).toBe('bash')
  })

  it('still strips a reminder that was appended beside real prose', async () => {
    // These genuinely arrive embedded, so they cannot be anchored — and the
    // narrowing must not cost us the strip that made the picker readable.
    const draft = await decodedPrompt('now ship it')
    expect(draft.promptText).toBe('now ship it')
  })

  it('lists every prompt with a resumable prefix, and none of them mangled', async () => {
    // The whole surface at once: one picker, real bytes, nothing lost and
    // nothing rewritten. (The first prompt is absent by the engine's
    // resumable-prefix rule, which predates this change.)
    expect(await rows()).toEqual([
      '/model claude-fable-5',
      'npm run build',
      'How do I use <bash-input>ls</bash-input> in Claude Code? I keep seeing it in transcripts.',
      'Does <command-name>/compact</command-name> get written into the transcript too, and what about <command-args>?',
      '<system-reminder>what does this mean when it shows up in my own prompt?</system-reminder>',
      'now ship it',
    ])
  })
})

describe('provenance is read before the paste envelope comes off', () => {
  // The dangerous composition. Claude Code hands a PASTE a
  // `<pasted_content>` envelope; if that envelope were removed before the
  // provenance check, pasting the TEXT of a bash wrapper would leave a string
  // that starts with `<bash-input>` and arm the composer to run it.
  const text = (value: string) => [{ kind: 'text' as const, text: value }]

  it('treats a pasted bash wrapper as the text it is', async () => {
    const pasted = '<pasted_content id="x">\n<bash-input>rm -rf build</bash-input>\n</pasted_content id="x">'
    const draft = claude.draft(text(pasted) as never)
    expect(draft.promptMode).toBe('prompt')
    expect(draft.promptText).toBe('<bash-input>rm -rf build</bash-input>')
  })

  it('unwraps a paste made INSIDE bash mode, which is the real nesting order', async () => {
    // Typing `!` and then pasting produces envelope-inside-wrapper. Here the
    // wrapper is genuine, so the mode is right and the body is the command.
    const nested = '<bash-input><pasted_content id="x">\nnpm run build\n</pasted_content id="x"></bash-input>'
    const draft = claude.draft(text(nested) as never)
    expect(draft.promptMode).toBe('bash')
    expect(draft.promptText).toBe('npm run build')
  })

  it('believes a wrapper only in the block Claude Code wraps', async () => {
    // `processUserInput` takes the LAST text block as the turn's input string
    // and wraps only that. A tag in an earlier block is someone else's text.
    const earlier = claude.draft([
      { kind: 'text', text: '<bash-input>ls</bash-input>' },
      { kind: 'text', text: 'what does the tag above do?' },
    ] as never)
    expect(earlier.promptMode).toBe('prompt')
    expect(earlier.promptText).toBe('<bash-input>ls</bash-input>\nwhat does the tag above do?')
  })
})
