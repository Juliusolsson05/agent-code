// Shared unknown-JSON narrowing helper.
//
// WHY this exists as a named helper instead of inline assertions:
// most transcript and provider payloads enter agent-code as
// `unknown` (from JSONL reads, IPC payloads, proxy events, ...).
// Two parallel hand-written copies of this exact predicate had
// drifted in subtle ways — one accepted `null`, one didn't; one
// excluded arrays, one didn't — and the resulting `as Record<...>`
// casts at the call sites quietly differed too. Centralizing makes
// the "object but not array, not null" invariant explicit at the
// boundary and gives consumers a single place to evolve the rule
// (e.g. if we ever want to reject typed-array views).

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const record = asRecord(item)
    return record ? [record] : []
  })
}

// Parse a JSON string and narrow the result to a record in one step.
//
// WHY co-located with asRecord: several semantic-render / proxy / transcript
// call sites hand-rolled `JSON.parse(...)` wrapped in the exact same
// object-but-not-array-not-null check (e.g. feed `renderUnits.parseRecord`).
// Folding that into one helper means the "is this a record" rule has a single
// definition and the try/catch-on-invalid-JSON behavior can't drift. Returns
// null for invalid JSON, non-object JSON (string/number/bool/null), and arrays.
export function parseJsonRecord(
  text: string | null | undefined,
): Record<string, unknown> | null {
  if (!text) return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}
