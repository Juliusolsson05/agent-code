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

/**
 * Will this pane eventually grow an agent-name row?
 *
 * WHY presentation needs to know this BEFORE the name exists, when
 * `resolveAgentName` deliberately refuses to answer early:
 *
 * A name arrives over IPC (`useAgentNameReconciler` -> `resolveAgentNames`)
 * tens to hundreds of milliseconds after the pane mounts, and only once
 * `restoreStatus` leaves 'pending'. AgentTitleHeader keyed its existence on
 * the name, so on every window load a named agent pane rendered no row, laid
 * its terminal out tall, told the PTY `rows: N` — and then, when the reply
 * landed, grew a ~23px row, shrank the terminal box, refit, and sent
 * `rows: N-1` as a SIGWINCH into a live, mid-output TUI. Ink and the Claude
 * Code TUI erase a line count computed for the pre-resize frame, so that
 * second resize overwrites the wrong region and leaves permanently garbled
 * fragments in the scrollback.
 *
 * Reserving the row from first paint removes the layout change entirely, so
 * there is no second resize to race. It is deliberately keyed on
 * `agentNamesEnabled` + session existence rather than on the identity or the
 * name, because those are the only two facts already known at mount: the
 * identity itself is claimed by a later effect, so keying on it would
 * reintroduce the same flip one step earlier. Provider kind no longer enters
 * this decision at all (#865): every session kind reserves the row now, the
 * same way every session kind is claimed and named.
 *
 * Same defensive optional reads as `agentNameForSession` above, for the same
 * phone-bundle reason: a keyless store must degrade, never throw.
 */
export function agentNameRowIsReserved(state: AppStore, sessionId: SessionId): boolean {
  if (state.settings?.agentNamesEnabled !== true) return false
  const meta = state.workspaceState?.sessions?.[sessionId]
  // Any existing session reserves the row while names are on (#865): a shell
  // now receives a name, so the same late-arrival resize hazard applies to it.
  return meta !== undefined
}
