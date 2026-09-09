/**
 * Limits shared by the renderer's identity validation and main's IPC schema.
 *
 * WHY these live in `shared` rather than being written twice: they are one
 * contract with two halves, and the halves silently drifted. `identityOf`
 * (renderer) checked only that an identity was a non-empty string, while
 * `agent-names:resolve` (main) validates `z.string().min(1).max(200)` over
 * the whole array. A single hand-edited `workspace.json` carrying one
 * over-long `agentNameId` therefore passed the renderer, entered the request
 * array, and made `requestSchema.parse` reject the ENTIRE batch — which the
 * reconciler swallows silently, so no agent in that window ever received a
 * name and nothing said why.
 *
 * The renderer's own comment already named main's schema verbatim, so the
 * intent was to mirror it; only the type half was actually mirrored, not the
 * length half. Importing the numbers makes the next divergence impossible.
 */

/** Longest accepted `agentNameId`. Mirrors main's per-item schema. */
export const AGENT_NAME_IDENTITY_MAX_LENGTH = 200

/**
 * Most identities one resolve request may carry.
 *
 * Bounded so a malformed or hostile renderer cannot make the allocator walk a
 * huge list under the serialization tail. Far past any real workspace.
 */
export const AGENT_NAME_IDENTITY_REQUEST_MAX = 10_000
