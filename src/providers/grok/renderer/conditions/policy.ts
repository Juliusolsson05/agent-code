// Grok condition policy.
//
// actionKinds is EMPTY BY DESIGN, exactly as OpenCode's: the action-kinds set
// routes keystrokes into a rendered provider's PTY while a blocking condition
// is up. Grok conditions surface native's reverse requests (interaction.*),
// whose recorded answers are STRUCTURED payloads over control
// (conditions/modules.ts in the headless package) — not keystrokes. The native
// TUI still answers its own requests locally when focused (first answer wins,
// interaction.permission), which is native behaviour, not a policy route.

import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'

export const GROK_CONDITION_POLICY: ProviderConditionPolicy = {
  destinations: {
    'grok.permission': 'condition-outlet',
    'grok.question': 'condition-outlet',
    'grok.plan-approval': 'condition-outlet',
  },
  attentionKinds: new Set(['grok.permission', 'grok.question', 'grok.plan-approval']),
  actionKinds: new Set(),
  attentionLabels: [
    { kind: 'grok.permission', label: 'ACTION' },
    { kind: 'grok.question', label: 'QUESTION' },
    { kind: 'grok.plan-approval', label: 'PLAN' },
  ],
}
