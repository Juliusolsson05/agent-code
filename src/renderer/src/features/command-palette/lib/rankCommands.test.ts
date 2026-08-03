import { describe, expect, it } from 'vitest'

import { rankCommands } from '@renderer/features/command-palette/lib/rankCommands'
import { COMMAND_SORT_MODES } from '@renderer/features/command-palette/lib/sortCommands'
import type { ResolvedCommand } from '@renderer/features/command-palette/types'

function cmd(id: string, title: string, keywords: string[] = []): ResolvedCommand {
  return {
    id,
    title,
    description: `${title} description`,
    surface: 'app',
    keywords,
    keepPaletteOpen: false,
    state: null,
    run: () => {},
  }
}

const titles = (commands: readonly ResolvedCommand[]): string[] =>
  commands.map(command => command.title)

const NO_HISTORY = new Map<string, number>()
const NOTHING_STARRED: Record<string, boolean> = {}

describe('rankCommands — search always beats the sort mode', () => {
  // THE invariant this feature had to not break. A sort mode governs the browse
  // state only; the moment a query exists, relevance owns the ordering. If this
  // ever fails, 'A – Z' is capable of pushing a tier-5 prefix match below a
  // tier-1 subsequence match — the inversion class `rankEntries` was extracted
  // to eliminate.
  const commands = [
    // Deliberately arranged so that alphabetical, catalog and recent orders all
    // disagree with relevance: the exact-prefix match sorts LAST alphabetically
    // and sits LAST in catalog order.
    cmd('apple', 'Apple Something'),
    cmd('banana', 'Banana Thing'),
    cmd('zebra', 'Zebra Mode'),
  ]
  const history = new Map([
    ['apple', 0.95],
    ['banana', 0.9],
  ])
  const starred = { apple: true, banana: true }

  it('puts the prefix match first under every sort mode', () => {
    for (const mode of COMMAND_SORT_MODES) {
      const result = rankCommands(commands, 'zebra', history, starred, mode)
      expect(result.commands[0]?.title, `mode: ${mode}`).toBe('Zebra Mode')
    }
  })

  it('is byte-identical across sort modes for any given query', () => {
    // Stronger than the check above: the sort mode must have NO observable
    // effect at all while searching, not merely leave the winner in place.
    const baseline = rankCommands(commands, 'an', history, starred, 'catalog')
    for (const mode of COMMAND_SORT_MODES) {
      const result = rankCommands(commands, 'an', history, starred, mode)
      expect(titles(result.commands), `mode: ${mode}`).toEqual(titles(baseline.commands))
    }
  })

  it('never emits section headers for a search result', () => {
    // Headers describe a browse structure; a relevance-ordered list has none.
    const result = rankCommands(commands, 'a', NO_HISTORY, NOTHING_STARRED, 'grouped')
    expect(result.commands.length).toBeGreaterThan(0)
    expect(result.headers.size).toBe(0)
  })
})

describe('rankCommands — browse state applies the sort mode', () => {
  const commands = [cmd('c', 'Charlie'), cmd('a', 'Alpha'), cmd('b', 'Bravo')]

  it('defaults to catalog order when no mode is supplied', () => {
    // The parameter is optional so existing call sites (and the native-menu
    // resolution path) keep today's behavior without being touched.
    const result = rankCommands(commands, '', NO_HISTORY, NOTHING_STARRED)
    expect(titles(result.commands)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  })

  it('sorts alphabetically on an empty query when asked', () => {
    const result = rankCommands(commands, '', NO_HISTORY, NOTHING_STARRED, 'alpha')
    expect(titles(result.commands)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('still hoists starred commands ahead of the sort', () => {
    const result = rankCommands(commands, '', NO_HISTORY, { c: true }, 'alpha')
    expect(titles(result.commands)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  })
})
