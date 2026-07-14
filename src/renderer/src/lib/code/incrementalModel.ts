// Monaco's `setValue` looks innocent, but it is a document replacement: it
// resets editor selections/undo state and makes the language worker process the
// entire buffer again. A streaming feed grows a file a few characters at a
// time, so using `setValue` would preserve the model object while throwing away
// most of the reason we preserved it.
//
// This deliberately tiny structural interface keeps the diff calculation
// testable without importing Monaco's browser-only runtime into Vitest. Monaco
// offsets and JavaScript string offsets are both UTF-16 code-unit offsets, so
// `getPositionAt` is the authoritative conversion even for non-ASCII content.
export interface IncrementalTextModel {
  getValue(): string
  getPositionAt(offset: number): { lineNumber: number; column: number }
  applyEdits(edits: Array<{
    range: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }
    text: string
  }>): unknown
}

/**
 * Replace only the changed middle of a Monaco model.
 *
 * WHY both a common prefix and suffix: provider deltas are normally appends,
 * but a partial JSON decoder may repair the current tail as an escape sequence
 * closes. Keeping an unchanged suffix out of the edit avoids needless Monaco
 * token invalidation in both cases. We step back over a UTF-16 surrogate
 * boundary because replacing half an astral character can briefly put an
 * invalid string into the model, which in turn produces bogus LSP positions.
 */
export function applyIncrementalModelText(
  model: IncrementalTextModel,
  next: string,
): boolean {
  const previous = model.getValue()
  if (previous === next) return false

  // Provider code streams are overwhelmingly append-only. Take that path
  // before the generic prefix+suffix repair so we avoid a second backward scan
  // and hand Monaco the exact zero-width append it can tokenize incrementally.
  // `startsWith` still validates the invariant; assuming append from length
  // alone would corrupt the model when a partial escape repairs its tail.
  if (next.length > previous.length && next.startsWith(previous)) {
    const at = model.getPositionAt(previous.length)
    model.applyEdits([{
      range: {
        startLineNumber: at.lineNumber,
        startColumn: at.column,
        endLineNumber: at.lineNumber,
        endColumn: at.column,
      },
      text: next.slice(previous.length),
    }])
    return true
  }

  const sharedLimit = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < sharedLimit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix += 1
  }

  // A high surrogate belongs to the following low surrogate. If the first
  // differing offset lands between them, include the pair in the replacement
  // rather than asking Monaco/LSP to observe a torn character.
  if (prefix > 0 && isHighSurrogate(previous.charCodeAt(prefix - 1))) {
    prefix -= 1
  }

  let previousEnd = previous.length
  let nextEnd = next.length
  while (
    previousEnd > prefix &&
    nextEnd > prefix &&
    previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }

  // The suffix scan can also stop between a surrogate pair. Pull the whole
  // pair into the edit for the same positional-integrity reason as above.
  if (
    previousEnd < previous.length &&
    previousEnd > prefix &&
    isHighSurrogate(previous.charCodeAt(previousEnd - 1))
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }

  const start = model.getPositionAt(prefix)
  const end = model.getPositionAt(previousEnd)
  model.applyEdits([
    {
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      text: next.slice(prefix, nextEnd),
    },
  ])
  return true
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}
