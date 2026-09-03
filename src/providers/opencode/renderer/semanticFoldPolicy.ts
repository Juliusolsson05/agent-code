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
// The strictness codex needs does not apply to this structured runtime:
// it has exactly ONE event stream (the server's SSE bus, republished verbatim
// by OpencodeSession) — no PTY, no proxy, no screen-scrape fallback, so
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
  // 'opencode-sse' stays trusted so the ended-turn handoff and (future)
  // yield hatches key off the real stream; with allowReplaceOfLiveTurn
  // false below, trust alone no longer displaces a LIVE turn.
  trustedReplaceSources: ['opencode-sse'],
  // FALSE (2026-07-06, second bundle 87f0eeef): the original `true` was
  // justified as "single server-authoritative stream has no racing
  // producer" — disproven live. OpenCode interleaves MULTIPLE concurrent
  // assistant messages on one SSE stream (parallel steps, reasoning
  // message + text message, agent-tool children before the headless
  // session filter landed). With live replacement on, interleaved events
  // ping-ponged the single live-turn slot — 30 turn_starteds across 4
  // alternating messageIDs, a 27↔29 visible-row render spasm. Strict
  // ownership (like codex) holds the slot until the current turn ends;
  // a concurrent message's deltas are dropped from the LIVE view but its
  // content still lands via the assembled committed entry, and it can
  // soft-open the slot the moment the current turn completes (ended-turn
  // handoff in canReplaceMismatchedTurn is universal).
  allowReplaceOfLiveTurn: false,
}
