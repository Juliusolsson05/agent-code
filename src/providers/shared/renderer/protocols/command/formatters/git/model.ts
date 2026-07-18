import type { GitIntent } from './detect'

/** Provider-neutral terminal model for the Git command formatter.
 *
 * `status` semantics are strict: `success` is granted ONLY when the provider
 * adapter proved exit 0 (or an equivalent hard success signal). `unknown`
 * covers transports that deliver output without exit evidence. Verb-specific
 * cards parse under a success assumption and therefore remain generic in that
 * state; an all-Git workflow may keep its factual step structure while using
 * neutral bullets and an explicit `exit unknown` badge. */
export type GitOperationModel = {
  command: string
  intent: GitIntent
  status: 'running' | 'success' | 'failure' | 'unknown'
  output?: string
}
