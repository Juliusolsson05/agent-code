import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

import type { AppStore } from '@renderer/app-state/types'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'

/**
 * The one place a spoken name is derived, for every consumer.
 *
 * WHY it is a pure function taking explicit inputs rather than reading the
 * store: workspace.observe has to resolve names for BURIED agents, whose
 * metadata lives outside `state.sessions`, and a store-reading selector could
 * not answer for them. Keeping the rule pure also means the header, the
 * Dispatch row and the operator observation cannot drift into three slightly
 * different definitions of "does this agent have a name".
 *
 * WHY it returns null instead of a placeholder: presentation must never mint,
 * and an operator must never be told about an address that does not resolve.
 * "No name yet" and "names are off" are both correctly invisible.
 */
export function resolveAgentName(input: {
  enabled: boolean
  meta: Pick<SessionMeta, 'kind' | 'agentNameId'> | undefined
  names: Record<string, string>
}): string | null {
  if (!input.enabled || !input.meta) return null
  if (!isAgentProviderKind(input.meta.kind ?? DEFAULT_PROVIDER)) return null

  const identity = input.meta.agentNameId
  if (!identity) return null

  // Own-property + typeof, not `names[identity] ?? null`. Identities originate
  // in a user-editable workspace file, so `constructor` or `toString` would
  // otherwise resolve to an inherited function and be rendered as a name.
  //
  // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`:
  // tsconfig.web.json targets lib ES2020, so `Object.hasOwn` does not
  // type-check. Same reason and same form as mouseBinding.ts and
  // sessionOwnership.ts.
  if (!Object.prototype.hasOwnProperty.call(input.names, identity)) return null
  const name = input.names[identity]
  return typeof name === 'string' && name.length > 0 ? name : null
}

/**
 * WHY every read here is optional and the map is defaulted:
 *
 * The phone bundle (src/remote-client) renders the real PaneHeader — and
 * therefore AgentTitleHeader — while aliasing `@renderer/app-state/hooks` to a
 * stub whose entire state is `{ settings }` (vite.config.ts). `workspaceState`
 * and `workspaceAgentNames` simply do not exist there, so an eager
 * `state.workspaceState.sessions[id]` throws while merely BUILDING this
 * argument object, before `enabled` is ever consulted.
 *
 * `tsc` cannot catch that: the alias lives only in the Vite config, while
 * tsconfig.web.json type-checks src/remote-client against the REAL hooks
 * module, so the eager version compiles cleanly and fails at runtime on a
 * device. Several renderer specs mock the store the same keyless way. The
 * repository already states the rule this obeys — "a keyless store must
 * degrade, never throw" (PaneHeader.phoneCoupling.renderer.test.tsx).
 *
 * Degrading to null is also the correct ANSWER on the phone, not merely a
 * safe one: it has no workspace, no reconciler and no allocation, so it has
 * no names to show.
 */
export function agentNameForSession(state: AppStore, sessionId: SessionId): string | null {
  return resolveAgentName({
    enabled: state.settings?.agentNamesEnabled === true,
    meta: state.workspaceState?.sessions?.[sessionId],
    names: state.workspaceAgentNames ?? {},
  })
}
