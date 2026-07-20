// Quote formatting — pure functions over (draft, selected text).
//
// Kept free of DOM and workspace imports on purpose: truncation,
// wrapping, and replace-existing are total functions of their inputs,
// which is what makes them reviewable and (later) coverable without a
// happy-dom harness.

/** Opening tag is matched by prefix, so the note text can be reworded
 *  later without orphaning quote blocks already sitting in drafts. */
const QUOTE_TAG = 'quoted-from-conversation'

// WHY an XML tag rather than `User replied to this: …` or a markdown
// blockquote:
//   Quoted feed text is very often code or markdown itself. A `> `
//   blockquote breaks the moment the selection contains a line starting
//   with `>`; a bare `User replied to this:` prefix gives the model no
//   way to tell where the quote ends when the selection spans lines.
//   A tag is unambiguous in both cases.
//
//   The repo already establishes this convention — agent-voice-dictation
//   wraps dictated text in `<stt note="…">` for exactly the same reason
//   (tell the model something about the text without preprocessing it).
//   See MANIFESTO.md.
const QUOTE_NOTE = 'The user selected this text from the conversation above and is replying to it.'

// WHY 2000: long enough that quoting a full tool result or a stack trace
// works unchanged, short enough that an accidental Cmd+A in a long
// session cannot dump the entire transcript into the composer. The cap
// is on the QUOTE only — the user's own draft is never truncated.
export const MAX_QUOTE_CHARS = 2000

const TRUNCATION_MARKER = '\n\n…[selection truncated]…\n\n'

/**
 * Middle-ellipsis truncation.
 *
 * WHY middle and not tail: the two ends of a selection carry the most
 * intent — the user dragged from something to something. Keeping the
 * head and dropping the tail loses the endpoint they finished on, which
 * is usually the thing they actually care about.
 */
export function truncateQuote(text: string): { text: string, truncated: boolean } {
  if (text.length <= MAX_QUOTE_CHARS) return { text, truncated: false }

  const keep = MAX_QUOTE_CHARS - TRUNCATION_MARKER.length
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return {
    text: `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(text.length - tail)}`,
    truncated: true,
  }
}

export function wrapQuote(text: string): string {
  return `<${QUOTE_TAG} note="${QUOTE_NOTE}">\n${text}\n</${QUOTE_TAG}>`
}

// Matches a quote block ONLY at the very start of a draft, plus the
// blank line separating it from the user's text.
//
// WHY anchored to the start: we replace the block this feature owns, and
// this feature only ever writes at position 0. A quote the user pasted
// into the middle of their own prose is theirs, not ours, and must
// survive untouched. `[\s\S]*?` is lazy so two stacked blocks (which we
// never write, but a user could paste) only cost the first one.
const LEADING_QUOTE_BLOCK = new RegExp(`^<${QUOTE_TAG}\\b[\\s\\S]*?</${QUOTE_TAG}>\\n*`)

export function stripLeadingQuoteBlock(draft: string): string {
  return draft.replace(LEADING_QUOTE_BLOCK, '')
}

/**
 * Put `selection` at the top of `draft`, preserving whatever the user
 * had already typed underneath.
 *
 * Running this twice replaces the previous quote rather than stacking a
 * second one: a second invocation is a mis-fire correction far more
 * often than an intent to quote two separate things, and "the top of the
 * composer" is one slot, not a growing list.
 */
export function prefixDraftWithQuote(
  draft: string,
  selection: string,
): { draft: string, truncated: boolean } {
  const { text, truncated } = truncateQuote(selection)
  const quote = wrapQuote(text)
  const body = stripLeadingQuoteBlock(draft)
  return {
    draft: body.length > 0 ? `${quote}\n\n${body}` : `${quote}\n\n`,
    truncated,
  }
}

/**
 * Short single-line preview for the command description.
 *
 * The command's availability is driven by a stash rather than a visible
 * highlight (see selectionStash.ts), so without a preview the user is
 * asked to trust that we captured the right thing. Showing the snippet
 * is what keeps this from being a blind action.
 */
export function quoteSnippet(text: string, maxChars = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars - 1)}…`
}
