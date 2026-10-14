import {
  CLAUDE_ATTENTION_CONDITION_KINDS,
  CODEX_ATTENTION_CONDITION_KINDS,
  GROK_ATTENTION_CONDITION_KINDS,
  HERMES_ATTENTION_CONDITION_KINDS,
  OPENCODE_ATTENTION_CONDITION_KINDS,
  PI_ATTENTION_CONDITION_KINDS,
} from '@shared/types/providerConditionAttention.js'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// Is the agent blocked on the user? (#964, decomposition §6 Q4: time blocked on
// a permission prompt or question is not agent working time.)
//
// WHY the shared attention-kind sets: the renderer's conditionRequiresAttention
// already decides "needs the human" from these exact sets (it is what releases
// feed auto-follow and paints attention badges). Main reads the same module, so
// a provider that adds a prompt kind changes both answers in one edit.

// Exhaustive over AgentProviderKind: this was a hand-kept `Record<string, …>`
// and a provider missing from it silently counted prompt time as working time
// (Grok before its fix). A new provider is now a compile error here.
const ATTENTION_KINDS: Readonly<Record<AgentProviderKind, ReadonlySet<string>>> = {
  claude: CLAUDE_ATTENTION_CONDITION_KINDS,
  codex: CODEX_ATTENTION_CONDITION_KINDS,
  opencode: OPENCODE_ATTENTION_CONDITION_KINDS,
  grok: GROK_ATTENTION_CONDITION_KINDS,
  pi: PI_ATTENTION_CONDITION_KINDS,
  hermes: HERMES_ATTENTION_CONDITION_KINDS,
}

/** Same rule as the renderer's conditionRequiresAttention: an attention-kind
 *  condition that is visible (or has no visibility flag). */
export function conditionsBlockOnUser(snapshot: ProviderConditionSnapshot | null): boolean {
  if (!snapshot) return false
  const kinds = (ATTENTION_KINDS as Readonly<Record<string, ReadonlySet<string> | undefined>>)[snapshot.provider]
  if (!kinds) return false
  for (const [kind, condition] of Object.entries(snapshot.conditions)) {
    if (!condition || !kinds.has(kind)) continue
    const state = condition.state as { visible?: boolean } | null
    if (typeof state?.visible === 'boolean' ? state.visible : true) return true
  }
  return false
}
