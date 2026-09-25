/**
 * Put a failed prompt back into the composer (#1181).
 *
 * WHY the draft is cleared at Enter and restored on failure, instead of the
 * old "keep it editable and clear the exact snapshot on acceptance":
 * Claude's JSONL acknowledgement can take many seconds, and during that window
 * the old composer still showed the prompt as an editable draft. It read as
 * "Enter did nothing" and invited a second Enter or edits to text that was
 * already on its way. The prompt now moves into the feed as a pending row and
 * the composer locks, so on success there is nothing left to clear. Failure is
 * the only case where the text has to come back.
 *
 * WHY merge instead of overwrite: the composer is locked against typing, but
 * not every writer goes through the textarea. Dictation, prompt templates,
 * reply-to-selection and the control API write `draftInput` directly, and a
 * send can take long enough for one of them to land. Overwriting would
 * silently destroy that text. The failed prompt goes FIRST because it is the
 * older intent. Whatever arrived during the send was written to follow it.
 */
export function draftAfterFailure(current: string, submitted: string): string {
  if (current.trim().length === 0) return submitted
  if (current === submitted) return current
  return `${submitted}\n\n${current}`
}

/**
 * The image half of `draftAfterFailure`. Submitted images go back first, and an
 * image that somehow still sits in the draft (same id) is not duplicated,
 * because ids are the identity that `removeDraftImage` and the submit's own
 * attachment list both key on.
 */
export function imagesAfterFailure<T extends { id: string }>(
  current: T[],
  submitted: readonly T[],
): T[] {
  if (submitted.length === 0) return current
  const submittedIds = new Set(submitted.map(image => image.id))
  return [...submitted, ...current.filter(image => !submittedIds.has(image.id))]
}
