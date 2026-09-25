/**
 * The identity of one Codex rollout line (#1288).
 *
 * WHY this exists, and why it is shared: Codex rollout lines carry no uuid,
 * so Agent Code synthesizes one. The renderer uses it as the entry uuid that
 * committed-record admission dedupes on, and as the pagination marker; main's
 * history loader computes the same marker to find an older page's anchor.
 * Those three were three copies of `${timestamp}:${id ?? call_id ?? type}`,
 * and that rule is not unique:
 *   - a `function_call` and its `*_output` in the same millisecond share
 *     `ts:call_id`, so the output was dropped as "already seen" and the tool
 *     card never got its result;
 *   - items identified only by their type (`message` has no id) collide on
 *     `ts:message`, so a second user or assistant message in the same
 *     millisecond never rendered.
 * The owner's corpus had 1,232 such collisions in 270 of 2,212 rollouts, 4 of
 * them this month. Admission is the same on the live, tail and older-page
 * paths, so the loss was permanent and silent.
 *
 * The rule, weakest id last:
 *   - a payload `id` is unique on its own: `ts:id` (unchanged);
 *   - a `call_id` item keeps `ts:call_id`; its output (`*_output`) gets
 *     `:output`, because the pair shares the call id by design;
 *   - anything else is identified by type alone, so the payload's content
 *     decides: `ts:type:<hash>`. Two different items differ; the SAME line
 *     read twice (chunk overlap, a tail re-read) still maps to the same
 *     identity, which is what dedupe needs.
 * A missing timestamp is '' (it was Date.now(), a new identity on every read).
 *
 * Markers are never persisted (historyLoader.ts header) and older pages are
 * anchored by byte offset, so changing the format needs no migration.
 */
export function codexRolloutIdentity(entry: Record<string, unknown>): string {
  const payload = isRecord(entry.payload) ? entry.payload : undefined
  const timestamp = String(entry.timestamp ?? '')
  const id = payload?.id
  if (id !== undefined && id !== null) return `${timestamp}:${String(id)}`
  const callId = payload?.call_id
  if (callId !== undefined && callId !== null) {
    const isOutput = typeof payload?.type === 'string' && payload.type.endsWith('_output')
    return `${timestamp}:${String(callId)}${isOutput ? ':output' : ''}`
  }
  const type = String(payload?.type ?? entry.type)
  return `${timestamp}:${type}:${fnv1a32(JSON.stringify(payload ?? entry))}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 32-bit FNV-1a, hex. Synchronous and dependency-free: this runs in the
 *  renderer per rollout line, where crypto.subtle is async. Collisions only
 *  matter between items with the same timestamp AND type, a handful at most,
 *  so 32 bits is ample. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
