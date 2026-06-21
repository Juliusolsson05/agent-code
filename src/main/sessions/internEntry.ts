// Per-session string interning for parsed JSONL transcript entries.
//
// #288 (PART B). A heap-snapshot retainer trace showed the MAIN process
// retains ~24k parsed JSONL transcript-entry objects, and the repeated
// metadata strings on those entries are NOT shared — `JSON.parse` mints a
// fresh String for every field on every line. The trace counted, for a
// single resumed session:
//
//   - the cwd path (`/…/agent-code`) held by `Object.cwd`        ×29,801
//   - `"assistant"` held by `Object.role`                        ×23,478
//   - `"assistant"` held by `Object.type`                        ×23,476
//   - the sessionId held by `Object.sessionId`                   ×20,198
//
// Every one of those is the SAME logical string parsed over and over. V8
// does not de-dupe `JSON.parse` output, so each copy is its own heap
// allocation kept alive for as long as we retain the entry. Interning the
// known-duplicate metadata fields collapses ×20k–46k copies down to ×1 per
// session — a large, free win because the entries stay structurally
// identical (interning preserves value equality; `a === b` already implies
// `a == b` for the duplicated strings, so no consumer can observe the
// change).
//
// WHY a per-session pool and not one global pool:
//
// The pool is itself a `Map<string, string>` that pins every distinct
// string we ever see. A process-global pool would therefore be an
// unbounded leak in its own right — it would accumulate every cwd,
// sessionId and gitBranch from every session opened in the lifetime of the
// app and never release them. Scoping the pool to the owning session (the
// coalescer buffer, the SubAgentWatcher, a single history load) means the
// pool's lifetime is exactly the lifetime of the entries it interns: when
// the owner is destroyed the closure is dropped and the whole pool is
// GC'd alongside the entries. Bounded by construction, no cleanup logic to
// get wrong.
//
// WHY only a FIXED set of fields and not a deep walk:
//
// Interning is only a win when the SAME string recurs many times. The
// metadata fields below repeat per-line across a whole transcript; the
// large unique payload bodies (message content, tool inputs/outputs) are
// distinct per entry, so interning them would never find a duplicate and
// would just cost a Map insertion (and an internal string hash, i.e. a
// walk over every character) for nothing. We deliberately touch only the
// handful of fields the retainer trace proved are duplicated.

/**
 * Build a per-owner string pool. Returns a closure over a private
 * `Map<string, string>`: given a string it returns the canonical
 * (first-seen-wins) instance; given anything else it returns the value
 * unchanged. Drop the closure to drop the pool.
 */
export function makeStringPool(): (s: unknown) => unknown {
  const pool = new Map<string, string>()
  return (s: unknown): unknown => {
    if (typeof s !== 'string') return s
    const existing = pool.get(s)
    if (existing !== undefined) return existing
    pool.set(s, s)
    return s
  }
}

// The fixed set of top-level fields known to duplicate per line. Sourced
// from the #288 retainer trace (cwd/role/type/sessionId) plus the adjacent
// low-cardinality metadata that travels with every Claude/Codex entry and
// has the same many-copies-of-one-value shape (gitBranch, userType,
// entrypoint, version, providerSessionId). Anything not in this list is
// left untouched — see the deep-walk rationale in the header.
const TOP_LEVEL_INTERNED_FIELDS = [
  'cwd',
  'sessionId',
  'gitBranch',
  'type',
  'role',
  'userType',
  'entrypoint',
  'version',
  'providerSessionId',
] as const

/**
 * Mutate `entry` IN PLACE, replacing the known high-duplication metadata
 * string fields with their interned instances from `intern`. Non-string
 * fields and absent fields are left alone. Also interns `message.role`
 * and `message.type` when `message` is an object, because the embedded
 * message carries the same duplicated role/type as the outer entry.
 *
 * Defensive by contract: a malformed or partial entry must never throw
 * here — JSONL parsing upstream already tolerates junk lines, and an
 * interning helper that could crash the parse loop would be strictly worse
 * than the duplication it set out to fix.
 */
export function internEntryFields(
  entry: Record<string, unknown>,
  intern: (s: unknown) => unknown,
): void {
  if (entry === null || typeof entry !== 'object') return

  for (const field of TOP_LEVEL_INTERNED_FIELDS) {
    const v = entry[field]
    // `intern` is a no-op for non-strings, but guarding here avoids a
    // pointless call (and a Map miss) for the common absent/object field.
    if (typeof v === 'string') entry[field] = intern(v)
  }

  const message = entry.message
  if (message !== null && typeof message === 'object') {
    const msg = message as Record<string, unknown>
    if (typeof msg.role === 'string') msg.role = intern(msg.role)
    if (typeof msg.type === 'string') msg.type = intern(msg.type)
  }
}
