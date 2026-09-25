// ProviderConditionOutlet — the renderer's single entry point for drawing live
// conditions. This used to hand-switch on provider and delegate to two
// per-provider outlets (ClaudeConditionOutlet / CodexConditionOutlet), each of
// which hand-mounted its modals. Those outlets are now DELETED: their per-kind
// logic moved into self-contained VIEW modules (claude/.../views.tsx,
// codex/.../views.tsx), and this component just picks the right view registry
// and feeds the snapshot to the ONE generic ConditionOutlet.
//
// WHY the surface hands in `onPtyAction` (not a sessionId): the outlet has one
// job — pick the provider's views and draw the snapshot — and a pty choice is
// WRITTEN differently by each surface that mounts it (#1177). TileLeaf writes
// the action's bytes through its own sendConditionKey; the phone sends the
// whole action so the desktop can verify it against the live menu. Both now
// mount this one outlet; makeOutletDispatch routes the pty arm to whichever
// write the surface passed.
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
import { makeOutletDispatch } from '@shared/conditions-core/dispatch'
import type { ConditionRefusalReporter } from '@shared/conditions-core/dispatch'
import type { ConditionCustomAction, ConditionPtyAction } from '@shared/conditions-core/contract'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { observeRenderShape } from '@renderer/features/feed/evidence/observer'
import type { RenderOutcomeRoute } from '@shared/types/renderShapes'
import type { ConditionDestination } from '@providers/registry.renderer.capabilities'

type Props = {
  sessionId: string
  conditions: ProviderConditionSnapshot | null
  onPtyAction: (action: ConditionPtyAction) => Promise<void>
  onResolveCustom?: (action: ConditionCustomAction) => Promise<unknown>
  /** Where a REFUSED custom action is told to the user (#1070). Optional so a
   *  surface that has nowhere to put it still renders; without one the refusal
   *  is silent, which is the bug. */
  onConditionRefused?: ConditionRefusalReporter
  interactionActive: boolean
}

export function conditionOutcomeForDestination(
  kind: string,
  destination: ConditionDestination | undefined,
): RenderOutcomeRoute {
  switch (destination) {
    case 'condition-outlet':
      return { kind: 'condition-surface', surface: 'outlet' }
    case 'feed-inline':
      return { kind: 'condition-surface', surface: 'feed-inline' }
    case 'composer':
      return { kind: 'condition-surface', surface: 'composer' }
    case 'attention-only':
      return { kind: 'condition-surface', surface: 'attention-only' }
    case 'intentional-hidden':
      // A deliberately non-visual condition still needs a receipt. Encoding it
      // as an absorption names the reviewed owner instead of manufacturing a
      // fake visible surface or returning null, either of which would make the
      // evidence system lie about what happened.
      return {
        kind: 'absorbed',
        ownerRenderId: 'provider.condition.intentional-hidden',
        reason: `Provider policy intentionally keeps ${kind} off visual surfaces.`,
      }
    case undefined:
      return { kind: 'unknown', fallbackRenderId: 'shared.condition-unhandled' }
  }
}

export function ProviderConditionOutlet({
  sessionId,
  conditions,
  onPtyAction,
  onResolveCustom,
  onConditionRefused,
  interactionActive,
}: Props) {
  if (!conditions) return null

  const capabilities = getRendererProviderCapabilities(conditions.provider)
  const { conditionViews: registry, conditionPolicy } = capabilities
  const dispatch = makeOutletDispatch(onPtyAction, onResolveCustom, onConditionRefused)

  for (const [kind, condition] of Object.entries(conditions.conditions)) {
    if (!condition) continue
    const outcome = conditionOutcomeForDestination(kind, conditionPolicy.destinations[kind])
    // Conditions live outside Feed's capture context, so observe against the
    // session directly. The observer's armed Map remains the sole dev-mode
    // gate; no capture state enters React and no condition render is changed.
    observeRenderShape({
      sessionId,
      provider: conditions.provider,
      plane: 'condition',
      lifecycle: 'running',
      eventType: kind,
      payload: condition,
      outcome,
    })
  }

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
