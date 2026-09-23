// Pi semantic fold policy (Grok's and OpenCode Terminal's are the template).
//
// The bridge publishes turn-scoped events (turn_started / stream_phase /
// api_error / turn_completed) under the single source 'pi-bridge'
// (pi-terminal-headless channels/types.ts), and the committed rows arrive
// separately from the session file. A Pi pane never mounts the rendered
// feed, but the ledger still folds these for Reader Mode, Dispatch rows and
// orchestration reads, so the rules match the other native-TUI providers:
// trust only 'pi-bridge', let the committed row own final text, never replace
// a live turn's text from committed rows, never auto-replace on a guessed
// turn mismatch.

import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

export const PI_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  autoReplaceOnTurnMismatch: false,
  softOpenTurnFromBlockSources: ['pi-bridge'],
  canReplaceTurnFromBlock: true,
  trustedReplaceSources: ['pi-bridge'],
  allowReplaceOfLiveTurn: false,
}
