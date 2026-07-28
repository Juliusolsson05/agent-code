import type { CommandSurface, ResolvedCommand } from '@renderer/features/command-palette/types'

// sortCommands — how the command list is ordered when the user is BROWSING
// rather than searching.
//
// WHY this module exists at all. The palette had exactly one ordering story and
// it was built for the keyboard: type three characters and `rankEntries` does
// the work. Not typing got you catalog registration order, verbatim. That order
// is deliberate — `catalog.ts` declares it a user-visible invariant and
// `catalog.test.ts` pins it — but it is deliberate about AUTHORING ADJACENCY
// ("like things stay adjacent"), which is a different goal from FINDABILITY. A
// mouse user who does not already know the command's name gets no affordance
// from it: no alphabet to scan, no categories to narrow by eye, just ~99 rows.
//
// WHY it is a separate module from `rankCommands`. Two genuinely different
// questions, and keeping them apart is what stops the second from eroding the
// first:
//
//   rankCommands / rankEntries  — "how well does this row match what you typed"
//   sortCommands                — "how do you want to scan a list you have not
//                                 typed into"
//
// They never compete, because sorting is only ever consulted when the query is
// empty (see the guard in `rankCommands`). A sort mode that reordered SEARCH
// results would let 'alpha' push a tier-5 prefix match below a tier-1
// subsequence match — exactly the inversion class the ranking rewrite existed
// to eliminate. That is why this module has no notion of a query at all: it
// cannot violate the rule it does not have the inputs to violate.
//
// Pure on purpose — no React, no storage, no Date.now() — matching its
// neighbours `rankEntries.ts` and `rankCommands.ts`, so the whole ordering story
// stays testable without a DOM.

export type CommandSortMode = 'catalog' | 'alpha' | 'grouped' | 'recent'

/** Every valid mode, for persistence coercion and for rendering the picker.
 *  Declared as a const tuple so the menu, the settings coercion and the type
 *  all derive from ONE list — a fifth mode added to the union but forgotten
 *  here would otherwise be silently unreachable in the UI. */
export const COMMAND_SORT_MODES = ['catalog', 'alpha', 'grouped', 'recent'] as const

export function isCommandSortMode(value: unknown): value is CommandSortMode {
  return typeof value === 'string' && (COMMAND_SORT_MODES as readonly string[]).includes(value)
}

/** Short label for the control's resting state and its menu rows. Kept beside
 *  the modes rather than in the component so a new mode cannot ship nameless. */
export const COMMAND_SORT_MODE_LABELS: Record<CommandSortMode, string> = {
  catalog: 'Catalog order',
  alpha: 'A – Z',
  grouped: 'Grouped',
  recent: 'Recently used',
}

/**
 * Order in which surface groups are presented in `grouped` mode.
 *
 * WHY this fixed order and not the `CommandSurface` union's declaration order:
 * this is a browse sequence, so it runs most-general to most-specialized —
 * `app` (always meaningful) first, `debug` (developer tooling) last. The union
 * in `types.ts` is a taxonomy, not a ranking, and coupling the two would mean a
 * future reordering of the type for readability silently reshuffled the UI.
 *
 * `grid` and `dispatch` are mutually exclusive at runtime — `surfaceAvailable`
 * in `registry.ts` hides one or the other depending on Dispatch Mode — so at
 * most one of those two sections can ever render. Both are listed because this
 * module has no way to know which mode is active, and must not care.
 */
const SURFACE_ORDER: readonly CommandSurface[] = [
  'app',
  'session',
  'grid',
  'dispatch',
  'editor',
  'debug',
]

const SURFACE_LABELS: Record<CommandSurface, string> = {
  app: 'App',
  session: 'Session',
  grid: 'Grid',
  dispatch: 'Dispatch',
  editor: 'Editor',
  debug: 'Debug',
}

/** The starred section's label in `grouped` mode. Starring already hoists rows
 *  to the top invisibly (see `rankCommands`); grouped mode is the one view that
 *  can afford to say so out loud. */
export const STARRED_GROUP_LABEL = '★ Starred'

export type CommandGroup = {
  label: string
  commands: ResolvedCommand[]
}

/**
 * The browse-state ordering, plus the section headers that go with it.
 *
 * ONE function returning BOTH because they must never disagree. An earlier
 * draft had the component call a sort function and a separate grouping
 * function; that is two derivations of the same order, and the failure mode is
 * silent and ugly — a header rendered above the wrong row, with the flat array
 * the selection model indexes still believing something else. Deriving the flat
 * list BY FLATTENING the groups makes the two structurally incapable of
 * drifting.
 *
 * `headers` is keyed by position in the returned `commands` array — the same
 * array the caller renders and `selectedIndex` indexes — and is empty for every
 * mode except `grouped`.
 */
export type BrowseOrder = {
  commands: ResolvedCommand[]
  /** Readonly so the shared `EMPTY_HEADERS` singleton below can be handed out
   *  to every non-grouped caller without any of them being able to mutate it
   *  for all the others. */
  headers: ReadonlyMap<number, string>
}

export function browseOrder(
  commands: readonly ResolvedCommand[],
  mode: CommandSortMode,
  historyScore: Map<string, number>,
  starred: Record<string, boolean>,
): BrowseOrder {
  if (mode === 'grouped') {
    const groups = groupCommands(commands, starred)
    const flat: ResolvedCommand[] = []
    const headers = new Map<number, string>()
    for (const group of groups) {
      // The header's index is wherever this group's first row lands in the
      // flattened list, which is simply the length so far. Computing it from a
      // running offset rather than an `indexOf` lookup keeps this exact even if
      // two groups were ever to contain the same command object.
      headers.set(flat.length, group.label)
      flat.push(...group.commands)
    }
    return { commands: flat, headers }
  }

  // Non-grouped modes: stars stay hard-partitioned to the top (the behavior
  // `rankCommands` has always had — see its comment block, which defends
  // starring as the ONE thing allowed to perturb the resting order), and the
  // chosen sort applies WITHIN each half.
  //
  // WHY sorting does not simply override the star partition: starring answers
  // "which commands are mine" and sorting answers "how do I want to scan the
  // list". They are orthogonal, and letting a sort mode dissolve the user's
  // explicit pins would mean choosing A–Z silently unpinned everything.
  const starredRows = commands.filter(command => starred[command.id])
  if (starredRows.length === 0) {
    return { commands: orderFlat(commands, mode, historyScore), headers: EMPTY_HEADERS }
  }
  const rest = commands.filter(command => !starred[command.id])
  return {
    commands: [
      ...orderFlat(starredRows, mode, historyScore),
      ...orderFlat(rest, mode, historyScore),
    ],
    headers: EMPTY_HEADERS,
  }
}

/**
 * The "this list has no sections" value.
 *
 * One shared instance rather than a fresh `new Map()` per call, for two
 * reasons: the result feeds a `useMemo` the palette re-reads on every render,
 * so a stable reference keeps downstream comparisons honest; and typing it
 * `ReadonlyMap` means every non-grouped caller can safely be handed the SAME
 * object without one of them being able to mutate it for all the others.
 *
 * Exported because `rankCommands` needs the same value for its search-result
 * path — search results are never sectioned either, and two separately-declared
 * empty maps for one concept is exactly the kind of near-duplicate that drifts.
 */
export const EMPTY_HEADERS: ReadonlyMap<number, string> = new Map()

/**
 * Compare by title, with the caller's array index as the deterministic
 * tiebreak.
 *
 * The index fallback matters more than it looks: two commands can share a title
 * (a per-provider generated pair, or a state-dependent `title(ctx)` that
 * resolved to the same string), and without it `Array.sort` falls through to
 * implementation-defined behavior for equal elements — meaning the list could
 * reorder itself between renders with no input change. `rankEntries` guards the
 * same hazard the same way, deliberately.
 *
 * `localeCompare` rather than `<`: titles are user-facing prose containing
 * digits ("Focus Pane 2", "Focus Pane 10"), and `numeric` keeps 2 before 10.
 */
function byTitleThenIndex(
  a: { command: ResolvedCommand; index: number },
  b: { command: ResolvedCommand; index: number },
): number {
  const byTitle = a.command.title.localeCompare(b.command.title, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
  return byTitle !== 0 ? byTitle : a.index - b.index
}

/** Flat ordering for the non-grouped modes. Split out so the star partition
 *  above can apply the same rule to each half without duplicating it. */
function orderFlat(
  commands: readonly ResolvedCommand[],
  mode: CommandSortMode,
  historyScore: Map<string, number>,
): ResolvedCommand[] {
  if (mode === 'catalog') return [...commands]

  const decorated = commands.map((command, index) => ({ command, index }))

  if (mode === 'alpha') {
    decorated.sort(byTitleThenIndex)
    return decorated.map(entry => entry.command)
  }

  // `recent`: history score DESC, then catalog order for everything the user
  // has never run. The unscored tail keeping catalog order (rather than falling
  // to alphabetical) is deliberate — the point of this mode is "float what I
  // use", not "reorganize everything", so the part of the list the mode has no
  // opinion about should look exactly like it always did.
  decorated.sort((a, b) => {
    const scoreA = historyScore.get(a.command.id) ?? 0
    const scoreB = historyScore.get(b.command.id) ?? 0
    if (scoreA !== scoreB) return scoreB - scoreA
    return a.index - b.index
  })
  return decorated.map(entry => entry.command)
}

/**
 * Split a flat command list into rendered sections.
 *
 * Exported for its own tests; the palette consumes it through `browseOrder`.
 *
 * Empty groups are dropped rather than rendered as bare headers — a section
 * heading over nothing reads as a bug, and in practice at least two of the six
 * surfaces are empty in any given mode (`grid` and `dispatch` can never both be
 * populated).
 */
export function groupCommands(
  commands: readonly ResolvedCommand[],
  starred: Record<string, boolean>,
): CommandGroup[] {
  const groups: CommandGroup[] = []

  // Starred first, and NOT re-sorted alphabetically: a starred row's position
  // is the one thing the user has expressed a direct opinion about, so the
  // section preserves the order it arrived in.
  const starredCommands = commands.filter(command => starred[command.id])
  if (starredCommands.length > 0) {
    groups.push({ label: STARRED_GROUP_LABEL, commands: starredCommands })
  }

  const rest = commands
    .filter(command => !starred[command.id])
    .map((command, index) => ({ command, index }))

  for (const surface of SURFACE_ORDER) {
    const inSurface = rest.filter(entry => entry.command.surface === surface)
    if (inSurface.length === 0) continue
    // Alphabetical WITHIN a group. Once the section headings carry the
    // structure, catalog adjacency inside a section stops earning its keep —
    // the user is scanning a short labelled list at that point, and A–Z is the
    // fastest thing to scan.
    inSurface.sort(byTitleThenIndex)
    groups.push({
      label: SURFACE_LABELS[surface],
      commands: inSurface.map(entry => entry.command),
    })
  }

  return groups
}
