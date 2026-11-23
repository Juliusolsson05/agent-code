// Antigravity condition policy.
//
// `antigravity.permission` is a real decision, not attention-only: agy sends
// it as an ACP session/request_permission with the exact options it accepts
// (recorded on 1.5.15: Allow / Deny), and the turn waits until the client
// answers. The card renders those options as buttons, and the answer goes
// back over ACP (AntigravitySession.resolveCondition) — no keystrokes.

import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'
import { ANTIGRAVITY_ATTENTION_CONDITION_KINDS } from '@shared/types/providerConditionAttention'

export const ANTIGRAVITY_CONDITION_POLICY: ProviderConditionPolicy = {
  destinations: {
    'antigravity.permission': 'condition-outlet',
  },
  // Shared with main's Agent Analytics (providerConditionAttention.ts).
  attentionKinds: ANTIGRAVITY_ATTENTION_CONDITION_KINDS,
  actionKinds: new Set(),
  attentionLabels: [
    { kind: 'antigravity.permission', label: 'ACTION' },
  ],
}
