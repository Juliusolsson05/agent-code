/**
 * Clear only the snapshot whose delivery was acknowledged.
 *
 * WHY this is pure and tested: Claude JSONL acknowledgement can take many
 * seconds, while the textarea intentionally remains editable. An unconditional
 * `setInputText('')` destroys the user's next prompt when the previous request
 * finally resolves.
 */
export function draftAfterAcceptance(current: string, submitted: string): string {
  return current === submitted ? '' : current
}

export function imagesAfterAcceptance<T extends { id: string }>(
  current: T[],
  submittedIds: ReadonlySet<string>,
): T[] {
  return current.filter(image => !submittedIds.has(image.id))
}
