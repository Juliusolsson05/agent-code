// Claude transcript-entry mapper — the provider-owned half of JSONL
// ingestion (#394 phase 2b).
//
// WHY this exists: the exact same "unwrap progress wrapper → filter to
// conversation/compact entries → derive uuid marker" sequence was
// duplicated in FOUR places (live ingest, initial history, older
// history, session preview), each hand-forked against the codex
// equivalent. The mapper owns the provider-specific mapping; the call
// sites keep their genuinely site-specific policies (dedupe, tool
// indexing, marker-update rules, optimistic reconciliation).
//
// The Claude mapper is stateless — Claude entries carry stable uuids
// and no cross-entry turn cursor. The TranscriptEntryMapper interface
// still has the cursor methods (no-ops here) because Codex's mapper
// needs them and the call sites treat mappers uniformly.

import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import type {
  MappedTranscriptEntry,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'
import {
  claudeHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
} from './history'
import { classifyClaudeDurableEntry } from '@providers/claude/renderer/entries/classify'
import { unwrapClaudePastedContent } from '@shared/claude/pastedContent.js'

export function createClaudeTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      const feedEntry = extractEmbeddedClaudeProgressEntry(raw) ?? (raw as Entry)
      const marker = claudeHistoryMarker(raw)
      const durableKind = classifyClaudeDurableEntry(feedEntry)
      // The conversation/compact filter lives HERE (not at call sites)
      // so all four ingestion paths inherit identical semantics — the
      // old duplication had already drifted (live ingest cleared
      // old live-only path cleared a second compaction cache here while bootstrap didn't; the
      // caller keeps that decision, but what COUNTS as a feed entry is
      // provider truth and belongs to the provider).
      if (
        !isConversationEntry(feedEntry) &&
        !isCompactBoundaryEntry(feedEntry) &&
        !isCompactSummaryEntry(feedEntry) &&
        durableKind === null
      ) {
        return { entries: [], historyMarker: marker }
      }
      return { entries: [feedEntry], historyMarker: marker }
    },
    // Claude has no rolling turn cursor — uuids are stable per entry.
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

/**
 * Pass-A identity capture: which durable provider session id does this
 * raw line claim? Claude stamps `sessionId` on (almost) every entry.
 */
export function extractClaudeProviderSessionId(
  raw: Record<string, unknown>,
): string | null {
  return typeof raw.sessionId === 'string' && raw.sessionId.length > 0
    ? raw.sessionId
    : null
}

/**
 * Is this text-bearing, non-meta Claude user row a prompt the user typed?
 *
 * Claude writes its own scaffolding as NON-meta user rows: `<command-name>`
 * and `<local-command-stdout>` markers, "Unknown skill: …" error replies,
 * tool-result-only rows. The positive signal is `permissionMode`: Claude
 * stamps it on the rows the user submitted, not on isMeta rows, error replies
 * or local-command markers. The `<` guard is belt and braces for the marker
 * family: a `<command-…>`/`<local-command-…>` row is excluded even if it ever
 * carries the stamp (latestUserPrompts.test.ts pins that case).
 *
 * The envelope is unwrapped BEFORE that guard (#1052 review). Claude Code
 * 2.1.278 wraps every pasted prompt in `<pasted_content id="…">`, which makes
 * the text start with `<` — so the guard, written for Claude's own markers,
 * silently deleted the user's longest prompts from composer history
 * (usePromptHistory reads this predicate). Unwrapping only accepts a whole,
 * unambiguous envelope, so arbitrary provider scaffolding still cannot pass
 * itself off as something the user typed.
 */
export function isClaudeTypedUserPrompt(entry: Entry, text: string): boolean {
  if ((entry as { permissionMode?: string }).permissionMode === undefined) return false
  return !(unwrapClaudePastedContent(text) ?? text).startsWith('<')
}

/**
 * The user's own words from a Claude user row: the envelope removed, if this
 * is entirely one.
 *
 * WHY this exists beside the predicate rather than inside it (#1059): the
 * predicate unwrapped only to DECIDE whether the row was the user's, and
 * passed the raw envelope on to everything that shows or replays it. The feed
 * painted `❯ <pasted_content id="cade"> …`, a pasted prompt's pane title
 * began with `<pasted_content id="…`, and ⌘↑ put the envelope back in the
 * composer — where sending it again made Claude wrap the already-wrapped
 * text, one envelope deeper per round trip.
 *
 * Anything that is not a whole, unambiguous envelope is returned untouched,
 * because `unwrapClaudePastedContent` refuses to guess — see its guards.
 */
export function claudeTypedUserPromptText(text: string): string {
  return unwrapClaudePastedContent(text) ?? text
}
