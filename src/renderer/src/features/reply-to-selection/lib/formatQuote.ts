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

// WHY 2000: long enough that quoting a stack trace or a normal tool
// result works unchanged, short enough that dragging across a very long
// message — a full file dump, a thousand-line diff — cannot push the
// whole thing into the composer. The cap is on the QUOTE only; the
// user's own draft is never truncated.
//
// (An earlier version of this comment justified the cap as protection
// against an accidental Cmd+A. That reason does not hold: Cmd+A anchors
// the selection in <body>, which resolves to no quote scope at all and
// never reaches the stash. The cap earns its place on long single
// messages, not on select-all.)
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

  // Split on code points, not UTF-16 units. A raw `slice` at an
  // arbitrary index can land between the two halves of a surrogate pair
  // and leave a lone surrogate that renders as `�`. Feed text is full of
  // emoji (agents use them in summaries), so this is reachable, not
  // theoretical.
  const units = Array.from(text)

  // `Math.max(0, …)` keeps this total. The arithmetic below goes negative
  // if MAX_QUOTE_CHARS is ever set below the marker length, and negative
  // slice indices count from the END of the string — which would silently
  // return MORE text than the cap, the exact opposite of the intent.
  // Nothing can reach that today (the cap is a constant), but a guard is
  // cheaper than the next person re-deriving why it must not be lowered.
  const keep = Math.max(0, MAX_QUOTE_CHARS - TRUNCATION_MARKER.length)
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  const tailText = tail > 0 ? units.slice(units.length - tail).join('') : ''
  return {
    text: `${units.slice(0, head).join('')}${TRUNCATION_MARKER}${tailText}`,
    truncated: true,
  }
}

// Neutralize any closing tag inside the payload before wrapping.
//
// WHY THIS IS NOT OPTIONAL:
//   Feed code blocks render literally, so a user working on THIS repo
//   can select a line containing `</quoted-from-conversation>` — and
//   dogfooding is how this repo gets built, so that is a normal Tuesday,
//   not an adversarial input.
//
//   Two things break without it. First the model: an agent reading a
//   quote whose body contains an early closing tag will treat everything
//   after it as the user's own words, silently mis-attributing the
//   quote. Second the draft: `stripLeadingQuoteBlock` matches lazily and
//   would stop at that inner tag, so a second invocation leaves an
//   orphaned `</quoted-from-conversation>` fragment stranded in the
//   composer.
//
//   Sealing here rather than making the strip regex cleverer fixes both
//   halves at once, and keeps the invariant simple: a block written by
//   `wrapQuote` contains exactly one closing tag, its own.
//
// The `<\/` form is the long-established escape for this exact problem
// (`<\/script>` inside inline JS). It stays readable to the model as the
// literal text it came from.
// `RegExp` + split/join rather than `String.replaceAll`: the web
// tsconfig's lib target predates ES2021. QUOTE_TAG is a hyphenated
// literal with no regex metacharacters, so it needs no escaping.
const CLOSING_TAG_PATTERN = new RegExp(`</${QUOTE_TAG}`, 'g')

function sealQuotePayload(text: string): string {
  return text.replace(CLOSING_TAG_PATTERN, `<\\/${QUOTE_TAG}`)
}

export function wrapQuote(text: string): string {
  return `<${QUOTE_TAG} note="${QUOTE_NOTE}">\n${sealQuotePayload(text)}\n</${QUOTE_TAG}>`
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
