// OpenCode condition policy (#406, wiring step 2 stub — step 6 fills
// the views).
//
// actionKinds is EMPTY BY DESIGN, permanently: the action-kinds set
// routes keystrokes into a rendered provider's PTY while a blocking condition
// is up, and structured OpenCode HAS no PTY — routing keystrokes there would
// silently eat them (#406 §B-4). Structured OpenCode conditions resolve
// through custom actions (HTTP permission replies) only; OpenCode Terminal is
// forced onto the raw terminal surface and never uses this policy.

import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'

export const OPENCODE_CONDITION_POLICY: ProviderConditionPolicy = {
  destinations: {
    'opencode.permission': 'condition-outlet',
    'opencode.question': 'condition-outlet',
  },
  attentionKinds: new Set(['opencode.permission', 'opencode.question']),
  actionKinds: new Set(),
  attentionLabels: [
    { kind: 'opencode.permission', label: 'ACTION' },
    { kind: 'opencode.question', label: 'QUESTION' },
  ],
}
