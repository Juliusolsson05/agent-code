// Pi condition policy.
//
// Both kinds are ATTENTION-ONLY: they raise the Dispatch badge and mark a
// backgrounded pane unread, and nothing else. Pi has no permission system and
// no question tool (research/census-2026-09-22.md in pi-terminal-headless);
// what blocks it is a dialog pi renders itself — an extension's
// ui.confirm/select/input (`pi.dialog`) or pi's project-trust selector at
// startup (`pi.trust`). Answering those from outside would mean driving pi's
// own selector with keystrokes against a list Agent Code never sees, so the
// user answers in the TUI (the pane IS the TUI) and the condition clears when
// pi reports the dialog closed. actionKinds is empty for the same reason: no
// keystroke routing.

import type { ProviderConditionPolicy } from '@providers/registry.renderer.capabilities'
import { PI_ATTENTION_CONDITION_KINDS } from '@shared/types/providerConditionAttention'

export const PI_CONDITION_POLICY: ProviderConditionPolicy = {
  destinations: {
    'pi.dialog': 'attention-only',
    'pi.trust': 'attention-only',
  },
  // Shared with main's Agent Analytics (providerConditionAttention.ts).
  attentionKinds: PI_ATTENTION_CONDITION_KINDS,
  actionKinds: new Set(),
  attentionLabels: [
    { kind: 'pi.trust', label: 'TRUST' },
    { kind: 'pi.dialog', label: 'QUESTION' },
  ],
}
