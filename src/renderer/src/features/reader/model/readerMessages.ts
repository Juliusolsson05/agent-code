import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { assistantEntryText } from '@renderer/features/copy-assistant/lib/extractAssistantByUuid'
import { blockContentKind } from '@renderer/rendering/observations/semantic'

// ---------------------------------------------------------------------------
// Reader Mode's content model: the ledger's feed items, narrowed to prose.
//
// WHY Reader projects Feed's item list instead of reading runtime slices
// itself (#855):
//
// Reader used to assemble its own list — every committed assistant entry, plus
// `semantic.currentTurn.text` while the session ran, plus a fallback that
// scraped the Claude TUI screen when no semantic text was open. That third
// source is what painted Claude Code's background-agent panel ("⏺ main",
// "◯ general-purpose … ↓ 550.2k tokens") as the agent's answer: the panel
// renders below the prompt footer and its `⏺ main` row matches the scraper's
// "last ⏺ starts the assistant block" rule. The first two sources were wrong
// in quieter ways: `currentTurn.text` ignores the compaction-synthesis refusal
// (#345), the live/committed dedupe was a whole-string compare, and raw entries
// include whatever the ledger deliberately keeps off screen.
//
// The ledger already decides all of that for Feed — ownership between live and
// committed text, sidechain exclusion, compaction refusal, block
// classification. Reusing its output makes the contract one sentence: Reader
// pages through exactly the assistant prose Feed paints, and nothing else.
// ---------------------------------------------------------------------------

export type ReaderMessage = {
  /** The feed item's key. Stable while the ledger attributes the text to the
   *  same painted unit (a live block keeps its id as it grows); it changes
   *  when the ledger hands finished text to its committed entry
   *  (`semantic-block:…` -> `entry:…`). readerSelection.ts follows that
   *  handoff by text so the reader keeps their place. */
  id: string
  text: string
  /** True while the text is still growing: a block in the open semantic turn
   *  that has not reached its terminal state. Drives Reader's
   *  follow-the-bottom scrolling. WHY not simply "owned by the current turn":
   *  the Claude fold keeps a turn current after its text finished while tool
   *  results are pending, and treating that finished text as live pinned a
   *  reader to the bottom of a message that would never grow again. */
  live: boolean
  /** The provider message this text belongs to: a committed entry's
   *  `message.id`, or a semantic item's turn id. For Claude the two are the
   *  same value — the ledger suppresses a finished semantic turn by exactly
   *  that match (ownership.ts whole-turn rule) — which is how
   *  readerSelection.ts follows a page into an entry that joins several pages
   *  and so matches none of their texts. Null when the entry carries no id. */
  sourceId: string | null
}

function entrySourceId(entry: FeedRenderItem & { type: 'entry' }): string | null {
  const id = (entry.entry as { message?: { id?: unknown } }).message?.id
  return typeof id === 'string' ? id : null
}

// assistantEntryText joins every text block of an entry; during streaming the
// projection re-runs on each semantic delta and would redo that join for every
// committed entry in the session. Entries are immutable objects the ledger
// hands back by reference (the D11 identity chain), so a WeakMap memo makes the
// committed part of the projection a lookup and frees itself with the entries.
const entryTextMemo = new WeakMap<object, string | null>()

function memoAssistantEntryText(entry: FeedRenderItem & { type: 'entry' }): string | null {
  const cached = entryTextMemo.get(entry.entry)
  if (cached !== undefined) return cached
  const text = assistantEntryText(entry.entry)
  entryTextMemo.set(entry.entry, text)
  return text
}

/** The ledger's "this text block is done" rule, restated for liveness: a
 *  Codex message can reach status 'completed' without finalized:true, so both
 *  count (mirrors `textTerminal` in rendering/observations/semantic.ts). */
function blockStillGrowing(block: { finalized?: boolean; status?: string }): boolean {
  return block.finalized !== true && block.status !== 'completed'
}

export function readerMessagesFromFeedItems(
  items: readonly FeedRenderItem[],
): ReaderMessage[] {
  const messages: ReaderMessage[] = []
  for (const item of items) {
    switch (item.type) {
      case 'entry': {
        // User prompts, system rows and tool-only assistant carriers return
        // null here. Reader is a reading view of what the agent SAID.
        const text = memoAssistantEntryText(item)
        if (text) messages.push({ id: item.key, text, live: false, sourceId: entrySourceId(item) })
        break
      }
      case 'semantic-text': {
        // Blockless turns (Codex / OpenCode deliver prose only on turn.text).
        // There is no block to ask whether it finished, so the open turn is
        // the best liveness signal these producers give.
        const text = item.text.trim()
        if (text) {
          messages.push({
            id: item.key,
            text,
            live: item.owner === 'semantic-current',
            sourceId: item.turnId,
          })
        }
        break
      }
      case 'semantic-block': {
        // The ledger approved this block for painting; Reader still keeps only
        // prose. Thinking, tool calls and tool results are Feed furniture.
        if (blockContentKind(item.block) !== 'assistant-text') break
        const text = item.block.text?.trim()
        if (text) {
          messages.push({
            id: item.key,
            text,
            live: item.owner === 'semantic-current' && blockStillGrowing(item.block),
            sourceId: item.turnId,
          })
        }
        break
      }
      // 'absorbed-entry' paints nothing in Feed either (its blocks belong to a
      // provider operation). 'semantic-collapsed-activity' is a tool-churn
      // receipt, 'work' is the busy indicator, 'empty' is the blank-feed
      // placeholder: none of them is something the agent wrote.
      default:
        break
    }
  }
  return messages
}
