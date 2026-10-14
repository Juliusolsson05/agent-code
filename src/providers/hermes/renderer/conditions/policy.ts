import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'
import { HERMES_ATTENTION_CONDITION_KINDS } from '@shared/types/providerConditionAttention'

/**
 * Every Hermes request renders in the pane's condition outlet, which the chat
 * surface places directly above the composer: the card IS the chat's prompt,
 * like a Telegram bot's inline keyboard. No action is a keystroke (there is no
 * PTY), so `actionKinds` is empty, as for OpenCode and Grok.
 */
export const HERMES_CONDITION_POLICY: ProviderConditionPolicy = {
  destinations: {
    'hermes.approval': 'condition-outlet',
    'hermes.clarify': 'condition-outlet',
    'hermes.sudo': 'condition-outlet',
    'hermes.secret': 'condition-outlet',
  },
  attentionKinds: HERMES_ATTENTION_CONDITION_KINDS,
  actionKinds: new Set(),
  attentionLabels: [
    { kind: 'hermes.approval', label: 'ACTION' },
    { kind: 'hermes.clarify', label: 'QUESTION' },
    { kind: 'hermes.sudo', label: 'ACTION' },
    { kind: 'hermes.secret', label: 'ACTION' },
  ],
}
