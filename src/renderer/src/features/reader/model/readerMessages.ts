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
  /** The feed item's key. Stable for as long as the ledger attributes the text
   *  to the same painted unit, which is what keeps the pager's selection put
   *  while a live block grows; it changes when the ledger hands a live block
   *  over to its committed entry, and ReaderView snaps to the newest message
   *  at that moment. */
  id: string
  text: string
  /** True while the text belongs to the semantic runtime's open turn (still
   *  streaming, or held open by the Claude fold while its tool results are
   *  pending). Drives Reader's follow-the-bottom scrolling, nothing else, so a
   *  retained-but-finished block being "live" costs nothing. */
  live: boolean
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
        const text = assistantEntryText(item.entry)
        if (text) messages.push({ id: item.key, text, live: false })
        break
      }
      case 'semantic-text': {
        // Blockless turns (Codex / OpenCode deliver prose only on turn.text).
        const text = item.text.trim()
        if (text) messages.push({ id: item.key, text, live: item.owner === 'semantic-current' })
        break
      }
      case 'semantic-block': {
        // The ledger approved this block for painting; Reader still keeps only
        // prose. Thinking, tool calls and tool results are Feed furniture.
        if (blockContentKind(item.block) !== 'assistant-text') break
        const text = item.block.text?.trim()
        if (text) messages.push({ id: item.key, text, live: item.owner === 'semantic-current' })
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
