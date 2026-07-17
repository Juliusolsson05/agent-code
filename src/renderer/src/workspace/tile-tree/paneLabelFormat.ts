/**
 * Convert a zero-based tab position to the spreadsheet-style prefix used by
 * every workspace coordinate (A..Z, AA..AZ, ...).
 *
 * WHY this tiny formatter has its own dependency-free module: paneLabels needs
 * Dispatch's canonical visible rows when Dispatch is the rendered surface,
 * while dispatchSelectors needs the tab prefix to construct those rows. Keeping
 * the primitive below both modules prevents a cycle and lets each higher-level
 * resolver depend on the actual source of truth it needs.
 */
export function tabIndexLabel(index: number): string {
  if (index < 0) return '?'
  let n = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}
