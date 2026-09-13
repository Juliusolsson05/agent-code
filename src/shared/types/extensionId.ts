/**
 * The extension-id shape, in ONE place.
 *
 * ── WHY THIS MODULE EXISTS ──
 * This pattern was previously written out in four files (`storage.ts`, `manifest.ts`,
 * `frameProtocol.ts`, and a doc comment in `apps/types.ts`) — and the one place that
 * mattered most, the `agent-code-ext://` scheme handler, had no copy at all. It took
 * `url.hostname` verbatim and used it as a path segment, so a request for
 * `agent-code-ext://../extension-grants.json` resolved the install root to the whole
 * state directory and the containment check then certified that wrong root.
 *
 * Four hand-copied regexes is exactly how one gets omitted. Everything that turns an
 * untrusted string into an extension identity imports from here.
 */

/** Lowercase, starts with a letter, max 64 chars. Safe as a path segment and a hostname. */
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * True when `id` is a well-formed extension id.
 *
 * Call this BEFORE using the value in any path join, URL, or filesystem operation —
 * not after. A containment check that resolves against an attacker-chosen root
 * validates the wrong thing.
 */
export function isValidExtensionId(id: unknown): id is string {
  return typeof id === 'string' && EXTENSION_ID_PATTERN.test(id)
}
