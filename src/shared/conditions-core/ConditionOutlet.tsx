// conditions-core / ConditionOutlet.tsx
//
// The ONE generic outlet. Replaces the two per-provider hand-switch outlets
// (ClaudeConditionOutlet / CodexConditionOutlet) with a single component that
// routes a snapshot through a kind-keyed registry of ConditionViews.
//
// WHY a registry instead of a switch
// ----------------------------------
// The old outlets enumerated each condition kind by hand: read state out of the
// snapshot by string key, map it to the modal's props inline, mount the modal.
// That coupled "which conditions exist" to "the outlet's source code". With a
// registry, the outlet knows NOTHING about specific kinds — it iterates the
// live conditions, looks each kind up in the provider's view registry, and
// renders that view. New conditions register a view; the outlet never changes.
//
// WHY we skip unknown kinds (forward compatibility)
// -------------------------------------------------
// The headless emitter and the app ship on independent cadences. A newer
// headless build may emit a condition kind this (older) app doesn't have a view
// for yet. Rather than crash or render garbage, we SKIP kinds with no
// registered view. The app degrades to "doesn't show that one condition" — the
// same graceful-old-client behavior the wire format already assumes.

import type { ReactElement } from 'react'
import type { ConditionSnapshot, ConditionAction } from './contract'
import type { ConditionView } from './view'

type Props = {
  snapshot: ConditionSnapshot
  // Kind → view registry for the snapshot's provider. The core stores ERASED
  // views (ConditionView<string, unknown>): it never reads `state`, it only
  // routes by `kind` and hands the state straight to the view's Component. That
  // erasure is sound precisely because routing is the core's only job — the
  // strongly-typed state is re-established inside each view module, which knows
  // its own kind.
  registry: Record<string, ConditionView>
  dispatch: (action: ConditionAction) => Promise<void>
}

export function ConditionOutlet({ snapshot, registry, dispatch }: Props): ReactElement | null {
  // Preserve iteration order of Object.values so blocking modals stack in the
  // same order they did under the old outlets. Object key order in the snapshot
  // map is insertion order from the headless emitter; we do NOT reorder it.
  const rendered: ReactElement[] = []

  for (const condition of Object.values(snapshot.conditions)) {
    if (!condition) continue
    const view = registry[condition.kind]
    // Unknown kind (app older than headless): skip, see file header WHY.
    if (!view) continue

    const Component = view.Component
    rendered.push(
      <Component
        key={condition.kind}
        state={condition.state}
        actions={condition.actions}
        dispatch={dispatch}
      />,
    )
  }

  if (rendered.length === 0) return null
  return <>{rendered}</>
}
