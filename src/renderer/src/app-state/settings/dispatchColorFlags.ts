// Dispatch color flags — the fixed swatch palette + coercion.
//
// A "color flag" is a per-agent marker the user sets from the "Set color flag"
// command to paint a thick strip on the right edge of that agent's Dispatch
// row, so a flagged agent is instantly spottable when scanning many running
// workflows. See docs/plans_and_ideas/2026-07-23-dispatch-color-flags.md.
//
// WHY a fixed palette rather than a free RGB/hex picker: the whole point is
// fast visual triage of a list, and a small set of high-contrast, distinct
// hues is both quicker to pick and easier to tell apart at a 10px strip than
// arbitrary user colors (two custom near-greens would defeat the feature). A
// custom-hex option can be layered on later without changing the storage shape
// (the stored value is an id from this table).
//
// WHY raw hex here and not theme tokens: these are deliberate signal colors
// whose meaning ("this is my red-flagged agent") must be stable and identical
// in light and dark — a theme token would drift the hue per theme and break the
// "always red" mental model. They are chosen to read on both surfaces.

export type ColorFlag = {
  /** Stable id persisted per session. Never change an existing id. */
  id: string
  /** Human label shown in the picker. */
  label: string
  /** The strip color painted on the Dispatch row's right edge, and the swatch
   *  fill in the picker. */
  color: string
}

// Ordered — this is the swatch order in the picker.
export const DISPATCH_COLOR_FLAGS: readonly ColorFlag[] = [
  { id: 'red', label: 'Red', color: '#ef4444' },
  { id: 'orange', label: 'Orange', color: '#f97316' },
  { id: 'yellow', label: 'Yellow', color: '#eab308' },
  { id: 'green', label: 'Green', color: '#22c55e' },
  { id: 'blue', label: 'Blue', color: '#3b82f6' },
  { id: 'purple', label: 'Purple', color: '#a855f7' },
] as const

export type ColorFlagId = (typeof DISPATCH_COLOR_FLAGS)[number]['id']

const BY_ID = new Map(DISPATCH_COLOR_FLAGS.map(flag => [flag.id, flag]))

export function isColorFlagId(value: unknown): value is ColorFlagId {
  return typeof value === 'string' && BY_ID.has(value)
}

export function colorFlagById(id: string | undefined): ColorFlag | undefined {
  return id === undefined ? undefined : BY_ID.get(id)
}

/**
 * Coerce a persisted `dispatchColorFlags` map: keep only object entries whose
 * value is a currently-valid flag id. A dropped/renamed color or a corrupted
 * blob degrades to "no flag" rather than throwing, matching how the rest of
 * `coerceSettings` treats unknown persisted data.
 */
export function coerceDispatchColorFlags(value: unknown): Record<string, ColorFlagId> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, ColorFlagId> = {}
  for (const [sessionId, flagId] of Object.entries(value as Record<string, unknown>)) {
    if (isColorFlagId(flagId)) out[sessionId] = flagId
  }
  return out
}
