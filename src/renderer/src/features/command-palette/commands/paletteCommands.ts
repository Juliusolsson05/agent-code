import type { CommandDef } from '@renderer/features/command-palette/types'

/**
 * The command palette's own command.
 *
 * WHY this exists, when opening the palette obviously worked before: it did
 * not work as a COMMAND. `useKeybinds` called a hard-coded `onCommandPalette?.()`
 * callback for ⌘⇧P, and no catalog entry named that behavior. The consequence
 * is the one the governance plan cares about — a chord with no command id
 * cannot be rebound, cannot appear in a keybinding Settings list, and cannot be
 * checked for collisions, because there is nothing to attach any of that to.
 *
 * Giving it an owner is the single approved catalog addition in this plan:
 * 102 baseline − 5 retired preferences + 1 = 98.
 *
 * WHY it is structurally omitted from its own picker results (see
 * `catalog.ts` consumers): a row that closes the list it lives in is a
 * confusing no-op. The user is already looking at the palette; offering to
 * open it is at best noise and at worst a way to toggle the surface shut by
 * accident. It stays fully present in the CATALOG — so Settings can bind it,
 * the checker can reserve its chord, and the native menu could dispatch it —
 * and is filtered only at the point of rendering palette rows.
 */
export const paletteCommands: CommandDef[] = [
  {
    id: 'open-command-palette',
    category: 'navigate',
    surface: 'app',
    title: 'Command Palette',
    description:
      '**What it does:** Opens the **command palette**.\n\n**Use when:** You want to search every available command.\n\n**Notes:** This row is hidden inside the palette itself — you are already here.',
    keywords: ['palette', 'command', 'search', 'run'],
    run: ({ ui }) => ui.openCommandPalette(),
  },
]

/**
 * Commands that never appear as palette ROWS, even though they are ordinary
 * catalog members everywhere else.
 *
 * Kept as an explicit exported set rather than a `pickerVisibility` tier: the
 * hidden tiers are a USER preference (revealable by override or the reveal-all
 * escape hatch), whereas this is a structural property of the surface. No
 * override should be able to put "open the palette" inside the palette.
 */
export const PALETTE_SELF_EXCLUDED_COMMAND_IDS: ReadonlySet<string> = new Set([
  'open-command-palette',
])
