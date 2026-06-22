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
// WHY the provider→registry pick stays a tiny switch:
// the only thing genuinely provider-specific now is "which registry"; the
// snapshot's `provider` tag is the source of truth. Everything else (per-kind
// routing, render order, unknown-kind skipping) is the generic outlet's job.

import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { ConditionOutlet } from '@shared/conditions-core/ConditionOutlet'
import { makeDispatchFromOnSend } from '@shared/conditions-core/dispatch'
import type { ConditionCustomAction } from '@shared/conditions-core/contract'
import { CLAUDE_VIEWS } from '@providers/claude/renderer/conditions/views'
import { CODEX_VIEWS } from '@providers/codex/renderer/conditions/views'

type Props = {
  conditions: ProviderConditionSnapshot | null
  onSend: (data: string) => Promise<void>
  onResolveCustom?: (action: ConditionCustomAction) => Promise<unknown>
}

export function ProviderConditionOutlet({ conditions, onSend, onResolveCustom }: Props) {
  if (!conditions) return null

  const registry = conditions.provider === 'claude' ? CLAUDE_VIEWS : CODEX_VIEWS
  const dispatch = makeDispatchFromOnSend(onSend, onResolveCustom)

  return (
    <ConditionOutlet snapshot={conditions} registry={registry} dispatch={dispatch} />
  )
}
