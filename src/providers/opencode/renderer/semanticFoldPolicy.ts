// OpenCode semantic fold policy (2026-07-06 rendering-pipeline fix).
//
// WHY opencode gets a LOOSER policy than codex: before this policy
// existed, opencode fell into codex's strict path by default — but
// every codex recovery hatch is keyed on `ev.source === 'proxy'`, and
// opencode's events all carry `source: 'opencode-sse'`. So the hatches
// never applied and any turnId mismatch was a hard drop. The
// 2026-07-06 debug bundle showed the result: 200 semantic events, 1
// committed entry — tool blocks keyed on sessionID mismatched the text
// turn keyed on messageID (headless bug, fixed separately in
// packages/opencode-headless) and the renderer amplified that into
// total block loss instead of degrading gracefully.
//
// The strictness codex needs does not apply here: opencode has exactly
// ONE event stream (the server's SSE bus, republished verbatim by
// OpencodeSession) — no PTY, no proxy, no screen-scrape fallback, so
// there are no racing producers that could thrash the live-turn slot.
// A new turnId from 'opencode-sse' is always a legitimate new turn as
// far as the server is concerned; trusting it is strictly better than
// dropping events on the floor.

import type { SemanticFoldPolicy } from '@shared/types/providerConfig'

export const OPENCODE_SEMANTIC_FOLD_POLICY: SemanticFoldPolicy = {
  autoReplaceOnTurnMismatch: false,
  // A tool block can be the first event of a turn the renderer ever
  // sees (headless keys tool blocks on sessionID today); soft-open so
  // the tool row renders instead of vanishing.
  softOpenTurnFromBlockSources: ['opencode-sse'],
  canReplaceTurnFromBlock: true,
  // Server-authoritative single stream: replacement allowed when the
  // current turn has ended (sequential handoff, same as every provider)
  // OR the event comes from the SSE stream itself — which is every
  // opencode event, making this effectively "the server's newest turn
  // wins". allowReplaceOfLiveTurn:true is what encodes that; the
  // displaced turn is still archived into semantic history, not lost.
  trustedReplaceSources: ['opencode-sse'],
  allowReplaceOfLiveTurn: true,
}
