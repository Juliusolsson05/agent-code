// A picked element, as text an agent can read in its composer (spec §4.7).
//
// WHY an XML-ish tag rather than prose: agents of every provider parse tag
// attributes reliably, and the selector/role/name triple is exactly what the
// agent needs to find the element again in its own snapshot or source.

export function formatElementChip(e: { url: string; selector: string; role: string; name: string; width: number; height: number }): string {
  return `<browser-element url="${attr(e.url)}" selector="${attr(e.selector)}" role="${attr(e.role)}" name="${attr(clip(e.name, 120))}" size="${Math.round(e.width)}×${Math.round(e.height)}" />`
}

/**
 * Insert at the caret, never blindly at the end (Cursor forum 167268: element
 * selections always appended). Pads with one space on each side only where the
 * neighbouring character is not already whitespace.
 */
export function insertAtCaret(draft: string, caret: number | null, chip: string): { text: string; caret: number } {
  const at = caret === null || caret < 0 || caret > draft.length ? draft.length : caret
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const text = `${before}${lead}${chip}${trail}${after}`
  return { text, caret: before.length + lead.length + chip.length + trail.length }
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
