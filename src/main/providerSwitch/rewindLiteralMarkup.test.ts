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
      '/llm-prep Please include the two full headless ones.',
      '/simplify',
      '/compact',
      // No row for the `<local-command-stdout>` turn: it is provider output,
      // not a prompt, so it is absent from this list by design.
    ])
  })
})

describe('both command breadcrumbs, because upstream writes two (#1071 review, 1)', () => {
  // Prompt-type slash commands (/loop, /simplify, plugin and user-invocable
  // skills) go through a DIFFERENT formatter that opens with
  // `<command-message>`, and in the local corpus that shape is the majority —
  // 136 turns against 105. A rule that only knew `<command-name>` turned every
  // one of those picker rows into raw XML and prefilled the composer with the
  // breadcrumb.
  it('reads a prompt-type command that opens with <command-message>', async () => {
    const draft = await decodedPrompt('<command-message>llm-prep')
    expect(draft.promptText).toBe('/llm-prep Please include the two full headless ones.')
    expect(draft.promptMode).toBe('prompt')
  })

  it('reads one with no <command-args> at all', async () => {
    const draft = await decodedPrompt('<command-message>simplify')
    expect(draft.promptText).toBe('/simplify')
  })

  it('leaves no trailing space when the args are present but EMPTY', async () => {
    // 7 of the 8 distinct recorded `<command-name>`-first shapes have
    // `<command-args></command-args>`; the composer would be prefilled with a
    // stray space on every one of them.
    const draft = await decodedPrompt('<command-name>/compact</command-name>\n            ')
    expect(draft.promptText).toBe('/compact')
  })
})

describe('provider command OUTPUT is not a prompt', () => {
  it('keeps a stdout breadcrumb out of the picker', async () => {
    // Claude Code composes the whole message
    // (`createUserMessage({content: '<local-command-stdout>…'})`); no user
    // types one, and 87 visible turns of this form exist locally, several with
    // raw ANSI escapes. The never-strip-to-nothing rule must not resurrect
    // them as picker rows.
    const draft = await decodedPrompt('<local-command-stdout>')
    expect(draft.promptText).toBe('')
    expect(await rows()).not.toContain('<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>')
  })

  it('still drops output that is wrapped around injected context', async () => {
    expect(claude.draft([{
      kind: 'text',
      text: '<local-command-stdout>done</local-command-stdout><system-reminder>a file opened</system-reminder>',
    }] as never).promptText).toBe('')
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

  it('reads the wrapper BODY from the anchored block, not the joined text', async () => {
    // The whole rule is "the anchored block's raw bytes". Reading the body
    // from the joined prompt text would let an earlier block supply the
    // command, the args or the bash body for a wrapper it does not own.
    const smuggled = claude.draft([
      { kind: 'text', text: '<command-args>--force --yes</command-args><bash-input>rm -rf /</bash-input>' },
      { kind: 'text', text: '<command-name>/compact</command-name>' },
    ] as never)
    expect(smuggled.promptText).toBe('/compact')
    expect(smuggled.promptMode).toBe('prompt')
  })

  it('reads the COMMAND from the anchored block when an earlier one names another', async () => {
    // `extractTagBody` returns the FIRST match, so reading the joined text
    // would run the command an earlier block names instead of the one Claude
    // Code actually wrapped.
    const smuggled = claude.draft([
      { kind: 'text', text: '<command-name>/clear</command-name>' },
      { kind: 'text', text: '<command-name>/compact</command-name>' },
    ] as never)
    expect(smuggled.promptText).toBe('/compact')
  })

  it('reads the BASH BODY from the anchored block, not an earlier one', async () => {
    const smuggled = claude.draft([
      { kind: 'text', text: '<bash-input>rm -rf /</bash-input>' },
      { kind: 'text', text: '<bash-input>ls</bash-input>' },
    ] as never)
    expect(smuggled.promptText).toBe('ls')
    expect(smuggled.promptMode).toBe('bash')
  })

  it('requires the whole opening tag, not a prefix of it', async () => {
    // `<bash-inputs-explained>` is not `<bash-input>`.
    const draft = claude.draft([{
      kind: 'text',
      text: '<bash-inputs-explained>the tag is <bash-input>ls</bash-input></bash-inputs-explained>',
    }] as never)
    expect(draft.promptMode).toBe('prompt')
    expect(draft.promptText).toContain('bash-inputs-explained')
  })

  it('does not let leading whitespace launder provenance', async () => {
    // Claude Code's own check is `startsWith` with no trim, and a message that
    // begins with a newline is one the user typed.
    const draft = claude.draft([{ kind: 'text', text: '\n<bash-input>ls</bash-input>' }] as never)
    expect(draft.promptMode).toBe('prompt')
  })

  it('carries pasted images through both wrapper branches', async () => {
    // A wrapper branch returns early, so it has to pass the images on itself.
    const image = {
      kind: 'image',
      value: { source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    }
    for (const text of ['<bash-input>ls</bash-input>', '<command-name>/compact</command-name>']) {
      const draft = claude.draft([image, { kind: 'text', text }] as never)
      expect(draft.promptImages, text).toEqual([{ mediaType: 'image/png', data: 'AAAA' }])
    }
  })

  it('believes no wrapper when the message does not END in text', async () => {
    // `processUserInput` only treats the LAST block as the turn's input when
    // that block is text; otherwise there is no wrapped input at all.
    const draft = claude.draft([
      { kind: 'text', text: '<bash-input>ls</bash-input>' },
      { kind: 'image', value: { source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } },
    ] as never)
    expect(draft.promptMode).toBe('prompt')
    expect(draft.promptText).toBe('<bash-input>ls</bash-input>')
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
