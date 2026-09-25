/**
 * What is left of the draft once its prompt was ACCEPTED.
 *
 * WHY the submitted text stays in `draftInput` for the whole send (#1181):
 * the composer VIEW is emptied and locked at Enter and the prompt is shown in
 * the feed as a pending row, but the store keeps the draft until the provider
 * accepts it. The store copy is the one that survives: autosave persists only
 * `draftInput`, and a session replacement transfers only the current draft
 * fields to the successor. The first version of #1181 cleared the draft at
 * Enter and restored it on failure. Review showed that a renderer reload
 * mid-send then lost the prompt for good, and that a replacement restored a
 * failed prompt into the retired session (PR #1183 review, Codex 1 and 2).
 * Failure therefore needs no restore at all: the draft simply becomes visible
 * again when the lock lifts.
 *
 * WHY strip instead of "clear if unchanged": the textarea is locked, but not
 * every writer goes through it. Dictation appends, and reply-to-selection and
 * templates can prepend. Text inserted during the send belongs to the NEXT
 * prompt and must survive, while the sent prompt must not reappear. The
 * submitted text is removed where those writers leave it (whole, at the start
 * or at the end). Anything else is kept as-is, because guessing at an edit
 * could delete words the user never sent.
 */
export function draftAfterAcceptance(current: string, submitted: string): string {
  if (current === submitted) return ''
  if (submitted.length === 0) return current
  if (current.startsWith(submitted)) return current.slice(submitted.length).replace(/^\s+/, '')
  if (current.endsWith(submitted)) return current.slice(0, -submitted.length).replace(/\s+$/, '')
  return current
}

/** The image half of `draftAfterAcceptance`: drop exactly the sent ids. */
export function imagesAfterAcceptance<T extends { id: string }>(
  current: T[],
  submittedIds: ReadonlySet<string>,
): T[] {
  return current.filter(image => !submittedIds.has(image.id))
}
