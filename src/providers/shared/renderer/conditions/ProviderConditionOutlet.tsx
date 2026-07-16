// ProviderConditionOutlet — the renderer's single entry point for drawing live
// conditions. This used to hand-switch on provider and delegate to two
// per-provider outlets (ClaudeConditionOutlet / CodexConditionOutlet), each of
// which hand-mounted its modals. Those outlets are now DELETED: their per-kind
// logic moved into self-contained VIEW modules (claude/.../views.tsx,
// codex/.../views.tsx), and this component just picks the right view registry
// and feeds the snapshot to the ONE generic ConditionOutlet.
//
// WHY keep accepting `onSend` (not a sessionId):
// TileLeaf already passes `send`, an onSend(data) callback bound to the active
// session. Re-threading a sessionId here just to re-bind sendInput would be
// strictly more plumbing for the same effect. makeDispatchFromOnSend wraps the
// existing onSend so the dispatch pty arm calls onSend(data) — byte-for-byte
// the exact send path the old outlets used.
//
// WHY this imports the capability-only registry instead of accepting a registry
// prop from TileLeaf:
// condition views are provider renderer capabilities, not pane shell chrome.
// Putting them on TileLeafProps made the shared provider contract import a
// renderer-only ConditionView type and forced every pane mount to carry a table
// that only this component consumes. The capability registry is intentionally
// split from registry.renderer.ts, so this lookup does NOT import TileLeaf and
// does not recreate the TileLeaf -> ProviderConditionOutlet -> registry ->
// TileLeaf cycle the first-pass split was designed to avoid.

import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { ConditionOutlet } from '@shared/conditions-core/ConditionOutlet'
import { makeDispatchFromOnSend } from '@shared/conditions-core/dispatch'
import type { ConditionCustomAction } from '@shared/conditions-core/contract'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

type Props = {
  conditions: ProviderConditionSnapshot | null
  onSend: (data: string) => Promise<void>
  onResolveCustom?: (action: ConditionCustomAction) => Promise<unknown>
  interactionActive: boolean
}

export function ProviderConditionOutlet({
  conditions,
  onSend,
  onResolveCustom,
  interactionActive,
}: Props) {
  if (!conditions) return null

  const { conditionViews: registry } = getRendererProviderCapabilities(conditions.provider)
  const dispatch = makeDispatchFromOnSend(onSend, onResolveCustom)

  // The app-side open snapshot types its map Partial (an artifact of
  // the per-provider mapped types it must absorb); conditions-core's
  // ConditionSnapshot wants a dense Record. Values are never actually
  // undefined at runtime — the evaluators emit dense maps and records
  // are only ever inserted whole. This cast is the ONE sanctioned
  // erasure at the outlet boundary, same role as `eraseRegistry` for
  // views (#394 phase 3).
  const snapshot = conditions as import('@shared/conditions-core/contract').ConditionSnapshot

  return (
    <ConditionOutlet
      snapshot={snapshot}
      registry={registry}
      dispatch={dispatch}
      interactionActive={interactionActive}
    />
  )
}
