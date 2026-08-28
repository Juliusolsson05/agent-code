import type { ResolvedCommand } from '@renderer/features/command-palette/types'
import { primary, rankEntries, secondary } from '@renderer/features/command-palette/lib/rankEntries'
import { rankCommands } from '@renderer/features/command-palette/lib/rankCommands'
import type { CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'
import { EMPTY_HEADERS } from '@renderer/features/command-palette/lib/sortCommands'
import type { PromptTemplate } from '@renderer/features/prompt-templates/types'

export type CommandPaletteRow =
  | { kind: 'command'; command: ResolvedCommand }
  | { kind: 'prompt-template'; template: PromptTemplate }

export type PaletteRowOrder = {
  rows: CommandPaletteRow[]
  headers: ReadonlyMap<number, string>
}

export type RankPaletteRowsOptions = {
  commands: ResolvedCommand[]
  promptTemplates: PromptTemplate[]
  query: string
  historyScore: Map<string, number>
  starred: Record<string, boolean>
  sortMode: CommandSortMode
  includePromptTemplates: boolean
}

/**
 * Builds the top-level palette's selectable rows without changing what an
 * empty command menu means.
 *
 * WHY this is a separate adapter over `rankCommands`: browse ordering contains
 * command-only concepts — stars, catalog order, categories and section
 * headers. Prompt templates must never leak into that path. They join only
 * after a non-empty query opts into a relevance list, where commands and
 * templates are peers and can be compared by the same tier ladder.
 *
 * Commands are ranked once by `rankCommands` before the heterogeneous pass.
 * That first pass preserves recent-history and star tiebreaks between commands;
 * the second pass provides cross-type relevance. Since `rankEntries` is stable,
 * equally strong command matches retain the exact ordering users had before
 * this feature, while a stronger template match can still outrank them.
 */
export function rankPaletteRows({
  commands,
  promptTemplates,
  query,
  historyScore,
  starred,
  sortMode,
  includePromptTemplates,
}: RankPaletteRowsOptions): PaletteRowOrder {
  const commandOrder = rankCommands(commands, query, historyScore, starred, sortMode)
  const commandRows: CommandPaletteRow[] = commandOrder.commands.map(command => ({
    kind: 'command',
    command,
  }))

  // Both conditions are load-bearing. The setting is an explicit opt-in, and
  // even an opted-in user asked for SEARCH results — not prompt content mixed
  // into the resting command catalog. Returning the original header map here
  // also keeps grouped browse mode byte-for-byte command-owned.
  if (!includePromptTemplates || query.length === 0) {
    return { rows: commandRows, headers: commandOrder.headers }
  }

  const templateRows: CommandPaletteRow[] = promptTemplates.map(template => ({
    kind: 'prompt-template',
    template,
  }))

  return {
    rows: rankEntries([...commandRows, ...templateRows], query, row => {
      if (row.kind === 'command') {
        return [
          primary(row.command.title),
          ...row.command.keywords.map(keyword => secondary(keyword)),
        ]
      }

      // Deliberately no `body(template.body)`: the top-level palette renders a
      // compact identifying row. A hit that exists only in hidden prompt prose
      // is surprising and turns long templates into relevance magnets. The
      // dedicated template picker still retains its broader body search.
      return [primary(row.template.title), secondary(row.template.description)]
    }),
    // Search results are relevance ordered, never grouped. This is the same
    // invariant `rankCommands` enforces for command-only searches.
    headers: EMPTY_HEADERS,
  }
}
