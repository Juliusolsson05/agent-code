// OpenCode condition policy (#406, wiring step 2 stub — step 6 fills
// the views).
//
// actionKinds is EMPTY BY DESIGN, permanently: the action-kinds set
// routes keystrokes into the provider PTY while a blocking condition
// is up, and opencode HAS no PTY — routing keystrokes there would
// silently eat them (#406 §B-4). Opencode conditions resolve through
// custom actions (HTTP permission replies) only.

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
