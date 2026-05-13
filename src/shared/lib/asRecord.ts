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
