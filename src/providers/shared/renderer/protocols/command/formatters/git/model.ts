import type { GitIntent } from './detect'

/** Provider-neutral terminal model for the Git command formatter.
 *
 * `status` semantics are strict: `success` is granted ONLY when the provider
 * adapter proved exit 0 (or an equivalent hard success signal). `unknown`
 * covers transports that deliver output without exit evidence — the rich Git
 * cards parse output under a success assumption (best-effort parsers can turn
 * an auth error into a clean-looking card), so they render only on proven
 * success; `unknown` keeps the exact output visible in the neutral command
 * grammar instead. */
export type GitOperationModel = {
  command: string
  intent: GitIntent
  status: 'running' | 'success' | 'failure' | 'unknown'
  output?: string
}
