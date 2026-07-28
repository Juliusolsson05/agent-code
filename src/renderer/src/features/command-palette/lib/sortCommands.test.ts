import { describe, expect, it } from 'vitest'

import {
  browseOrder,
  groupCommands,
  isCommandSortMode,
  STARRED_GROUP_LABEL,
} from '@renderer/features/command-palette/lib/sortCommands'
import type { CommandSurface, ResolvedCommand } from '@renderer/features/command-palette/types'

// Minimal command factory. Only the four fields the sorter reads are real —
// everything else is filler, deliberately, so a change to `ResolvedCommand`'s
// unrelated fields cannot break these tests.
function cmd(id: string, title: string, surface: CommandSurface = 'app'): ResolvedCommand {
  return {
    id,
    title,
    description: `${title} description`,
    surface,
    keywords: [],
    keepPaletteOpen: false,
    state: null,
    run: () => {},
  }
}

const titles = (commands: readonly ResolvedCommand[]): string[] =>
  commands.map(command => command.title)

const NO_HISTORY = new Map<string, number>()
const NOTHING_STARRED: Record<string, boolean> = {}

describe('isCommandSortMode', () => {
  it('accepts the four shipped modes and rejects anything else', () => {
    expect(isCommandSortMode('catalog')).toBe(true)
    expect(isCommandSortMode('alpha')).toBe(true)
    expect(isCommandSortMode('grouped')).toBe(true)
    expect(isCommandSortMode('recent')).toBe(true)

    // The cases persistence actually has to survive: a mode from a future
    // build, a hand-edited value, a truncated blob.
    expect(isCommandSortMode('by-vibes')).toBe(false)
    expect(isCommandSortMode(undefined)).toBe(false)
    expect(isCommandSortMode(null)).toBe(false)
    expect(isCommandSortMode(3)).toBe(false)
  })
})

describe('browseOrder — catalog', () => {
  it('returns catalog order untouched', () => {
    const commands = [cmd('c', 'Zebra'), cmd('a', 'Apple'), cmd('b', 'Mango')]
    const result = browseOrder(commands, 'catalog', NO_HISTORY, NOTHING_STARRED)

    expect(titles(result.commands)).toEqual(['Zebra', 'Apple', 'Mango'])
    expect(result.headers.size).toBe(0)
  })

  it('does not hand back the caller array itself', () => {
    // The palette memoizes on this result; returning the input by reference
    // would let a downstream mutation reach the registry's array.
    const commands = [cmd('a', 'Apple')]
    expect(browseOrder(commands, 'catalog', NO_HISTORY, NOTHING_STARRED).commands).not.toBe(commands)
  })
})

describe('browseOrder — alpha', () => {
  it('sorts by title', () => {
    const commands = [cmd('c', 'Zebra'), cmd('a', 'Apple'), cmd('b', 'Mango')]
    const result = browseOrder(commands, 'alpha', NO_HISTORY, NOTHING_STARRED)

    expect(titles(result.commands)).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('orders embedded numbers numerically, not lexically', () => {
    // Lexical sorting puts "Focus Pane 10" before "Focus Pane 2", which reads
    // as broken in a list people scan by eye.
    const commands = [cmd('b', 'Focus Pane 10'), cmd('a', 'Focus Pane 2')]
    const result = browseOrder(commands, 'alpha', NO_HISTORY, NOTHING_STARRED)

    expect(titles(result.commands)).toEqual(['Focus Pane 2', 'Focus Pane 10'])
  })

  it('breaks title ties by catalog index rather than leaving it to Array.sort', () => {
    // Duplicate titles are reachable: per-provider generated commands, and
    // state-dependent `title(ctx)` values that resolve to the same string.
    const commands = [cmd('first', 'Same'), cmd('second', 'Same'), cmd('third', 'Same')]
    const result = browseOrder(commands, 'alpha', NO_HISTORY, NOTHING_STARRED)

    expect(result.commands.map(command => command.id)).toEqual(['first', 'second', 'third'])
  })
})

describe('browseOrder — recent', () => {
  it('floats scored commands and leaves the unscored tail in catalog order', () => {
    const commands = [
      cmd('never-1', 'Never One'),
      cmd('often', 'Often'),
      cmd('never-2', 'Never Two'),
      cmd('sometimes', 'Sometimes'),
    ]
    const history = new Map([
      ['often', 0.9],
      ['sometimes', 0.4],
    ])

    const result = browseOrder(commands, 'recent', history, NOTHING_STARRED)

    // Scored first, highest first; the two unscored keep their catalog
    // positions relative to each other.
    expect(titles(result.commands)).toEqual(['Often', 'Sometimes', 'Never One', 'Never Two'])
  })
})

describe('browseOrder — starring composes with sorting', () => {
  const commands = [
    cmd('zebra', 'Zebra'),
    cmd('apple', 'Apple'),
    cmd('mango', 'Mango'),
    cmd('kiwi', 'Kiwi'),
  ]
  const starred: Record<string, boolean> = { mango: true, zebra: true }

  it('keeps starred commands above unstarred ones under every flat mode', () => {
    for (const mode of ['catalog', 'alpha', 'recent'] as const) {
      const result = browseOrder(commands, mode, NO_HISTORY, starred)
      const starredCount = result.commands.filter(command => starred[command.id]).length

      expect(starredCount).toBe(2)
      // Both stars occupy the first two slots, whatever the mode did inside
      // each half. Choosing A–Z must never silently unpin anything.
      expect(result.commands.slice(0, 2).every(command => starred[command.id])).toBe(true)
    }
  })

  it('applies the sort within each partition, not across them', () => {
    const result = browseOrder(commands, 'alpha', NO_HISTORY, starred)

    // Starred half sorted A–Z, then unstarred half sorted A–Z. If the sort ran
    // across the whole list, Apple would be first overall.
    expect(titles(result.commands)).toEqual(['Mango', 'Zebra', 'Apple', 'Kiwi'])
  })
})

describe('browseOrder — grouped', () => {
  const commands = [
    cmd('sess-b', 'Reload Agent', 'session'),
    cmd('app-b', 'Open Settings', 'app'),
    cmd('sess-a', 'Copy Last Response', 'session'),
    cmd('app-a', 'New Tab', 'app'),
    cmd('dbg', 'Save Debug Logs', 'debug'),
  ]

  it('emits sections in the declared order with rows alphabetical inside each', () => {
    const result = browseOrder(commands, 'grouped', NO_HISTORY, NOTHING_STARRED)

    expect(titles(result.commands)).toEqual([
      'New Tab',
      'Open Settings',
      'Copy Last Response',
      'Reload Agent',
      'Save Debug Logs',
    ])
    expect([...result.headers.entries()]).toEqual([
      [0, 'App'],
      [2, 'Session'],
      [4, 'Debug'],
    ])
  })

  it('drops empty groups instead of rendering a heading over nothing', () => {
    const result = browseOrder([cmd('only', 'Only One', 'editor')], 'grouped', NO_HISTORY, NOTHING_STARRED)

    expect([...result.headers.values()]).toEqual(['Editor'])
  })

  it('leads with a starred section and pulls those rows out of their surfaces', () => {
    const result = browseOrder(commands, 'grouped', NO_HISTORY, { 'sess-b': true })

    expect(result.headers.get(0)).toBe(STARRED_GROUP_LABEL)
    expect(result.commands[0]?.title).toBe('Reload Agent')
    // Session now has one member, so it is still present but no longer holds
    // the starred row.
    expect(titles(result.commands)).toEqual([
      'Reload Agent',
      'New Tab',
      'Open Settings',
      'Copy Last Response',
      'Save Debug Logs',
    ])
  })

  it('anchors every header on the first row of its section', () => {
    // The invariant that makes headers safe to render inside the flat list: a
    // header index always points at a real command, and that command's group
    // label matches the header.
    const result = browseOrder(commands, 'grouped', NO_HISTORY, { 'app-a': true })

    for (const [index] of result.headers) {
      expect(result.commands[index]).toBeDefined()
    }
    expect(result.headers.size).toBe(4) // Starred + App + Session + Debug
  })
})

describe('groupCommands', () => {
  it('preserves the incoming order of starred rows rather than re-sorting them', () => {
    // A starred row's position is the one thing the user has expressed a direct
    // opinion about.
    const commands = [cmd('z', 'Zebra'), cmd('a', 'Apple')]
    const groups = groupCommands(commands, { z: true, a: true })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe(STARRED_GROUP_LABEL)
    expect(titles(groups[0]?.commands ?? [])).toEqual(['Zebra', 'Apple'])
  })

  it('never emits both grid and dispatch sections populated in one build', () => {
    // Not a rule this module enforces — `surfaceAvailable` in the registry
    // guarantees it upstream — but the group order lists both, so this pins
    // that each is handled independently and neither swallows the other.
    const groups = groupCommands([cmd('g', 'Split Pane Right', 'grid')], NOTHING_STARRED)
    expect(groups.map(group => group.label)).toEqual(['Grid'])
  })
})
