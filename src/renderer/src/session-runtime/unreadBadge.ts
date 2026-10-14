import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'
import type { SessionKind } from '@renderer/workspace/types'

// WHY this rule has its own module (#1479): it used to live inside the Dispatch
// index component file (DispatchAgentList.tsx), which was fine while Dispatch
// was its only reader. Extensions now receive the same answer through
// `sessions.observe()` (apps/api/sessionStatus.ts), and a game's agent panel
// must show exactly the badge Dispatch shows. Importing a 1000-line React
// component module into the extension API to reach one pure function would
// drag Dispatch's whole import graph into the apps host; a copy would be how
// the two surfaces drift apart. Moving it here keeps one rule with two
// readers. The body below is unchanged by the move.

function dispatchAttentionLabel(runtime: {
  conditions?: ProviderConditionSnapshot | null
  processError?: string | null
}): string | null {
  const conditionLabel = dispatchAttentionLabelFromConditions(runtime.conditions ?? null)
  if (conditionLabel) return conditionLabel
  if (runtime.processError) return 'ERROR'
  return null
}

export type DispatchUnreadBadgeModel = {
  kind: 'output' | 'attention'
  /** The exact text the badge paints: NEW, ACTION, QUESTION, ERROR, … */
  text: string
}

/**
 * The unread badge a Dispatch row shows, or null for none.
 *
 * WHY the runtime's `unreadKind` is not the answer on its own: it records
 * what happened while the user was away, and it deliberately keeps
 * `attention` after the prompt that raised it is answered (attention outranks
 * a later turn's NEW until the user opens the pane). The badge instead asks
 * whether anything is blocking NOW. A live condition wins as ACTION/QUESTION;
 * a resolved attention degrades to NEW, because what is left to look at is the
 * output that followed. Deriving that here, from the same inputs the row
 * reads, keeps a test of "the user sees NEW after answering" honest: it
 * asserts this function, not the raw field.
 *
 * Shell terminals badge too, since #865: they used to be excluded because a
 * shell had no "finished" signal to mark output unread, but the foreground
 * monitor now provides one — and that same exclusion was also swallowing a
 * failed wake's ERROR. `kind` is therefore no longer a gate here; it stays in
 * the signature because the caller passes the row's kind and a future
 * kind-specific rule belongs in this one place rather than at the call site.
 * (An OpenCode Terminal pane was never `kind === 'terminal'` anyway: its kind
 * is `opencode` and only its runtime is terminal.)
 */
export function dispatchUnreadBadge(runtime: {
  unreadKind?: 'output' | 'attention' | null
  conditions?: ProviderConditionSnapshot | null
  processError?: string | null
}, _kind?: SessionKind): DispatchUnreadBadgeModel | null {
  const attentionLabel = dispatchAttentionLabel(runtime)
  if (attentionLabel) return { kind: 'attention', text: attentionLabel }
  if (runtime.unreadKind === 'attention' || runtime.unreadKind === 'output') {
    return { kind: 'output', text: 'NEW' }
  }
  return null
}
