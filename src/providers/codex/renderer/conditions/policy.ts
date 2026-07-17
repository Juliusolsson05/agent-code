// Codex condition policy (#394 phase 3). See the Claude counterpart
// for why this is explicit data rather than derived from views.

import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'

export const CODEX_CONDITION_POLICY: ProviderConditionPolicy = {
  destinations: {
    'codex.trust-dialog': 'condition-outlet',
    'codex.approval': 'condition-outlet',
  },
  attentionKinds: new Set(['codex.trust-dialog', 'codex.approval']),
  actionKinds: new Set(['codex.trust-dialog', 'codex.approval']),
  attentionLabels: [
    { kind: 'codex.approval', label: 'ACTION' },
    { kind: 'codex.trust-dialog', label: 'TRUST' },
  ],
  // Codex has no slash-picker condition — the composer picker stays
  // hidden for codex panes (composerPickerKind omitted).
}
