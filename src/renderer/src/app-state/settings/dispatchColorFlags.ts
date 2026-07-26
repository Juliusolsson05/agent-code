// Dispatch color flags — the fixed swatch palette + coercion.
//
// A "color flag" is a per-agent marker the user sets from the "Set color flag"
// command, so a flagged agent is instantly spottable when scanning many running
// workflows. It renders in two places: a thick strip on the right edge of that
// agent's Dispatch row, and a chunk of the right end of its pane's session
// header in the grid. See docs/plans_and_ideas/2026-07-23-dispatch-color-flags.md
// for the original feature and
// docs/superpowers/plans/2026-07-26-session-header-color-flag.md for the header
// surface. `useColorFlag` is the shared reader both surfaces go through.
//
// DO NOT RENAME the `Settings.dispatchColorFlags` key to drop the now-misleading
// "dispatch" prefix. The key name is itself persisted — it is what the flags are
// stored under in the zustand-persisted settings blob — so renaming it silently
// orphans every flag a user has already set unless it comes with a
// PERSIST_VERSION bump and a migration. The prefix is historical (the feature
// shipped in Dispatch first) and is not a claim about where the flag renders;
// the same applies to the `dispatch.color-flag.set` command id, which keys
// `Settings.commandVisibilityOverrides`.
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

// Ordered — this is the swatch order in the picker.
//
// `as const` with NO explicit element-type annotation: annotating the array as
// `readonly ColorFlag[]` (with `id: string`) would widen every `id` back to
// `string` and collapse `ColorFlagId` to `string`, throwing away the literal
// union that gives compile-time protection at every call site. The `ColorFlag`
// shape is DERIVED from the const below instead, so the two can never drift.
export const DISPATCH_COLOR_FLAGS = [
  { id: 'red', label: 'Red', color: '#ef4444' },
  { id: 'orange', label: 'Orange', color: '#f97316' },
  { id: 'yellow', label: 'Yellow', color: '#eab308' },
  { id: 'green', label: 'Green', color: '#22c55e' },
  { id: 'blue', label: 'Blue', color: '#3b82f6' },
  { id: 'purple', label: 'Purple', color: '#a855f7' },
] as const

/** A palette entry. `id` is the stable value persisted per session — never
 *  change an existing id. `color` is the strip fill (Dispatch row + swatch). */
export type ColorFlag = (typeof DISPATCH_COLOR_FLAGS)[number]

/** The narrow literal union `'red' | 'orange' | …`, not `string`. */
export type ColorFlagId = ColorFlag['id']

// Keyed by `string` (not `ColorFlagId`) on purpose: the lookups below take
// arbitrary/persisted strings and use the Map itself as the validity check.
const BY_ID = new Map<string, ColorFlag>(DISPATCH_COLOR_FLAGS.map(flag => [flag.id, flag]))

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
export function coerceDispatchColorFlags(value: unknown): Partial<Record<string, ColorFlagId>> {
  // Reject non-objects AND arrays (a persisted array would otherwise be walked
  // into {"0": …} numeric-string keys) — mirrors the sibling
  // coerceCommandVisibilityOverrides guard.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Partial<Record<string, ColorFlagId>> = {}
  for (const [sessionId, flagId] of Object.entries(value as Record<string, unknown>)) {
    if (isColorFlagId(flagId)) out[sessionId] = flagId
  }
  return out
}
