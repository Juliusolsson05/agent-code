import type {
  Entry,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import { mapCodexRolloutToFeedEntries } from '@renderer/workspace/codex/rollout'
import { extractEmbeddedClaudeProgressEntry } from '@renderer/workspace/claude/history'
import { indexEntryIntoMaps } from '@renderer/workspace/entries/utils'

// previewModel — turn a raw JSONL transcript tail into the exact inputs
// the real feed row components consume.
//
// WHY this produces `Entry[]` (not a bespoke flat model):
//   The first cut of this feature flattened the transcript into a
//   plain-text model and hand-rolled a renderer. It rendered, but it
//   was a fraction of the real feed — no markdown, no syntax
//   highlighting, no prompt/response visual distinction. The fix is to
//   stop reinventing the feed: emit the SAME normalized `Entry[]` the
//   feed renders, and let `EntryRow` (markdown via TextProse, code via
//   CodeBlock, prompt bands via UserBand, provider-specific tool rows)
//   do the rendering. The preview is then exactly the feed, just in a
//   smaller container.
//
// WHY we still route through the existing raw→Entry mappers
// (`mapCodexRolloutToFeedEntries`, `extractEmbeddedClaudeProgressEntry`)
// rather than parsing raw JSONL ourselves: those mappers encode a pile
// of hard-won provider quirks — Codex's synthetic AGENTS.md/env-context
// bootstrap messages, progress-wrapper unwrapping, exec-wrapper output
// stripping, compact-boundary synthesis. This mirrors exactly what the
// live history loader does in
// `src/renderer/src/workspace/hook/actions/initialHistory.ts`; the only
// things it omits are the live-session concerns a static preview has no
// use for (ghost reconciliation, worktree-activity ingest, seen-uuid
// dedup — the tail is a single contiguous chunk with no overlap).

// Everything the feed rows need that isn't a prop. `EntryRow` →
// `Block` → tool rows read `toolUseIndex` / `toolResultIndex` through
// React context to pair a tool_use with its (later-entry) tool_result;
// the preview supplies the same maps the live Feed builds.
export type PreviewModel = {
  entries: Entry[]
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
}

/**
 * Build the preview model from a raw JSONL transcript tail.
 *
 * `rawEntries` is exactly what `window.api.loadInitialHistory` returns
 * (`HistoryChunk.entries`) — untouched provider JSONL records. `kind`
 * selects the provider mapper. Never throws: the underlying mappers
 * already degrade malformed input to `[]`, and the indexer is total.
 */
export function buildPreviewModel(
  rawEntries: Record<string, unknown>[],
  kind: 'claude' | 'codex',
): PreviewModel {
  const entries: Entry[] = []
  const toolUseIndex = new Map<string, ToolUseBlock>()
  const toolResultIndex = new Map<string, ToolResultBlock>()

  for (const raw of rawEntries) {
    if (kind === 'codex') {
      // One rollout line can fan out to several feed entries (a
      // `compacted` line yields a boundary + summary + replacement
      // history). Index each so tool pairing works.
      for (const mapped of mapCodexRolloutToFeedEntries(raw)) {
        entries.push(mapped)
        indexEntryIntoMaps(mapped, toolUseIndex, toolResultIndex)
      }
      continue
    }
    // Claude: unwrap a live progress wrapper if present, else treat the
    // raw line as an Entry. Same filter the live history loader applies
    // so the preview and the feed agree on which lines are content.
    const feedEntry = extractEmbeddedClaudeProgressEntry(raw) ?? (raw as Entry)
    if (
      isConversationEntry(feedEntry) ||
      isCompactBoundaryEntry(feedEntry) ||
      isCompactSummaryEntry(feedEntry)
    ) {
      entries.push(feedEntry)
      indexEntryIntoMaps(feedEntry, toolUseIndex, toolResultIndex)
    }
  }

  return { entries, toolUseIndex, toolResultIndex }
}

/**
 * Count user-authored prompts in a preview model — the "N turns" the
 * pane header shows. A user is the unit a human counts a conversation
 * in. We require a text block: `role: 'user'` entries that carry only
 * `tool_result` blocks are tool output on the wire, not real turns.
 */
export function countUserTurns(entries: Entry[]): number {
  let turns = 0
  for (const entry of entries) {
    if (!isConversationEntry(entry) || entry.type !== 'user') continue
    if (isCompactSummaryEntry(entry)) continue
    const content = entry.message.content
    const hasText =
      typeof content === 'string'
        ? content.trim().length > 0
        : content.some(block => block.type === 'text')
    if (hasText) turns += 1
  }
  return turns
}
