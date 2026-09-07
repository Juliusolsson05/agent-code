import { useEffect, useMemo, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { agentNameIdentities, claimMissingIdentities } from '@renderer/workspace/agentNames/reconcile'
import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import type { WorkspaceState } from '@renderer/workspace/types'

/**
 * The one hook that keeps naming in step with workspace membership.
 *
 * WHY membership and not the transcript: a name changes when an agent is
 * created, restored, replaced, buried or closed — never when a token arrives.
 * Driving this from runtime updates would put an IPC round trip on the
 * streaming path for a value that does not change while a model is talking.
 *
 * WHY it is gated on the setting: the flag governs ALLOCATION, not only
 * display. A user who never enables Agent names must never cause a write to
 * agent-names.json, and enabling is what assigns names to the agents that
 * already exist.
 */
export function useAgentNameReconciler(
  state: WorkspaceState,
  setState: WorkspaceSetState,
  restoreStatus: WorkspaceRestoreStatus,
): void {
  const enabled = useAppStore(store => store.settings.agentNamesEnabled)
  const names = useAppStore(store => store.workspaceAgentNames)
  const setNames = useAppStore(store => store.setWorkspaceAgentNames)

  // Identities already sent to main. Without it the effect would re-request
  // every identity on each state change until the reply lands, and a slow disk
  // would turn one membership change into a burst of allocations.
  const requestedRef = useRef(new Set<string>())

  // WHY cancellation is unmount-scoped rather than a per-effect `cancelled`
  // flag: this effect's deps include `state` and `names`, so an ordinary
  // cleanup fires on every workspace change — discarding a reply that is
  // already in flight and, because those identities stay marked as requested,
  // never asking again. That stranded them permanently on the very first
  // render, where claiming state immediately re-runs the effect.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // WHY the identity list is derived through the same claim the write effect
  // commits, instead of from `state` directly: on mount the claim has not been
  // applied yet, so reading `state` would ask for the already-identified
  // agents in one request and the just-claimed ones in a second. Running the
  // pure function here makes both effects agree within a single render, so
  // the first request is the complete one and the follow-up finds nothing
  // missing. `claimMissingIdentities` is identity-preserving on a no-op, so
  // this costs nothing once the workspace has settled.
  //
  // Known and accepted: this means `claimMissingIdentities` runs twice per
  // workspace change — once here and once in the write effect — and returns a
  // fresh array each time, so the IO effect re-runs on every change and exits
  // at its `missing.length === 0` guard. A content-keyed memo (joining the
  // identities into a string) would remove both, and is deliberately NOT done:
  // the function is one pass over a session map that is tens of entries at
  // most, it allocates nothing when there is nothing to claim, and the key
  // would be a second representation of the identity set to keep correct. Add
  // it only if a profile ever names it.
  const identities = useMemo(
    () => (enabled && restoreStatus !== 'pending'
      ? agentNameIdentities(claimMissingIdentities(state))
      : []),
    [enabled, restoreStatus, state],
  )

  useEffect(() => {
    if (!enabled) {
      // Re-enabling should retry anything a failure left behind.
      requestedRef.current.clear()
      return
    }
    // 'pending' means bootstrap has not decided what the workspace contains.
    // Claiming identities against a half-built state would mint one for a
    // session that rehydration is about to replace.
    if (restoreStatus === 'pending') return
    // Updater form, like the sibling sanity hooks: it re-derives against the
    // freshest state in case a concurrent setState ran since this render.
    setState(claimMissingIdentities)
  }, [enabled, restoreStatus, setState, state])

  useEffect(() => {
    const missing = identities.filter(identity =>
      // Object.prototype.hasOwnProperty.call, not Object.hasOwn: lib is ES2020.
      !Object.prototype.hasOwnProperty.call(names, identity)
      && !requestedRef.current.has(identity))
    if (missing.length === 0) return
    for (const identity of missing) requestedRef.current.add(identity)

    void window.api.resolveAgentNames(missing)
      .then(resolved => {
        // Not `cancelled` — only "this window is gone". A reply that arrives
        // after the workspace moved on is still correct: it is keyed by
        // IDENTITY, so it belongs to whatever session now carries that
        // identity, and to nothing at all if the agent closed. Writing it is
        // what makes a replacement that completed mid-flight inherit its name.
        if (!mountedRef.current) return
        setNames(previous => {
          // WHY entries + spread instead of `merged[identity] = name`:
          //
          // An identity comes from a workspace file the user can edit, so it
          // can be the string "__proto__". Assigning that key on a plain
          // object invokes the PROTOTYPE SETTER — the value is silently
          // discarded and no own property appears. The naive loop then also
          // reads `merged['__proto__']`, gets Object.prototype, compares it
          // against 'Apollo', and concludes something changed. The result is a
          // new object every pass, so `names` changes, the effect re-runs, and
          // because the identity still is not an own property the filter
          // below re-requests it — an unbounded IPC + store-write + re-render
          // spin, on the one input shape the rest of this feature has already
          // been hardened against. Object spread and Object.fromEntries both
          // CreateDataProperty, so they produce a real own property here.
          //
          // The own-property guard on `previous` matters for the same reason:
          // a bare `previous[identity] !== name` would compare against
          // Object.prototype and report a change forever.
          const additions: Array<[string, string]> = []
          for (const [identity, name] of Object.entries(resolved)) {
            if (typeof name !== 'string' || name.length === 0) continue
            if (Object.prototype.hasOwnProperty.call(previous, identity) && previous[identity] === name) continue
            additions.push([identity, name])
          }
          // Identity-preserving on a no-op so the slice's Object.is bail keeps
          // the store reference stable. Returning a fresh object every time
          // would change `names`, re-run this effect, and — with these entries
          // just cleared from requestedRef below — loop forever on a reply
          // that added nothing.
          if (additions.length === 0) return previous
          return { ...previous, ...Object.fromEntries(additions) }
        })
      })
      // Never fabricate a name. A failed allocation is simply an agent with no
      // visible name until something changes.
      .catch(() => {})
      .finally(() => {
        // Clear on SETTLE, not only on rejection. Whatever this request
        // answered is now in `names` and will filter itself out; whatever it
        // did not answer must be free to be asked again on the next membership
        // change, rather than stranded in this set for the life of the window.
        // This does not re-run the effect on its own: on success `names`
        // changed and the recomputed `missing` is empty, and on failure no dep
        // changed at all — so a broken registry cannot become a hot loop.
        for (const identity of missing) requestedRef.current.delete(identity)
      })
  }, [identities, names, setNames])
}
