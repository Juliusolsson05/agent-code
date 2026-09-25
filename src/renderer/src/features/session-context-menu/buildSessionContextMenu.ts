import { DISPATCH_COLOR_FLAGS, type ColorFlagId } from '@renderer/app-state/settings/dispatchColorFlags'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { resolveCommandAvailability } from '@renderer/features/command-palette/resolveInvocation'
import type {
  CommandContext,
  CommandContextMenuGroup,
  CommandContextMenuPlacement,
  CommandDef,
} from '@renderer/features/command-palette/types'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import type { SessionId } from '@renderer/workspace/types'
import { toElectronAccelerator } from '@shared/keybindings'
import type { PopupMenuItem } from '@shared/types/popupMenu'

/**
 * What a Sessions row knows about itself when it asks for a menu (#1180).
 *
 * The row supplies the two facts only it can compute cheaply and that are not
 * commands: which lane a left click would use (`targetLaneIndex`, already
 * derived for the row's own click), and whether its goal loop is live (the
 * row already subscribes to that for its badge). Everything else comes from
 * the workspace through the CommandContext.
 */
export type SessionMenuRequest = {
  sessionId: SessionId
  /**
   * Label for "Show in <label>", e.g. "Lane 2". Absent for a disabled row:
   * its agent is already shown in another lane of this grid row, and a left
   * click does nothing there either.
   */
  showInLaneLabel?: string
  /** Whether "Stop Goal Loop" applies — see `requires: 'goal-loop'`. */
  goalLoopLive: boolean
  /** Window coordinates for a keyboard-opened menu; absent = at the cursor. */
  x?: number
  y?: number
}

/** A menu pick, mapped back from the opaque id main returns. */
export type SessionMenuChoice =
  | { kind: 'show-in-lane' }
  | { kind: 'spotlight' }
  | { kind: 'flag'; flag: ColorFlagId | null }
  | { kind: 'command'; commandId: string }

const SHOW_IN_LANE = 'show-in-lane'
const SPOTLIGHT = 'spotlight'
const FLAG_NONE = 'flag:none'
const FLAG_PREFIX = 'flag:'
// WHY commands are namespaced rather than using the bare command id: the three
// non-command ids above live in the same space. A future command named
// `spotlight` would otherwise be silently shadowed by the built-in item.
const COMMAND_PREFIX = 'command:'

export function parseSessionMenuChoice(id: string): SessionMenuChoice | null {
  if (id === SHOW_IN_LANE) return { kind: 'show-in-lane' }
  if (id === SPOTLIGHT) return { kind: 'spotlight' }
  if (id === FLAG_NONE) return { kind: 'flag', flag: null }
  if (id.startsWith(FLAG_PREFIX)) {
    const flag = DISPATCH_COLOR_FLAGS.find(candidate => candidate.id === id.slice(FLAG_PREFIX.length))
    return flag ? { kind: 'flag', flag: flag.id } : null
  }
  if (id.startsWith(COMMAND_PREFIX)) return { kind: 'command', commandId: id.slice(COMMAND_PREFIX.length) }
  return null
}

// Group order top to bottom (plan D4). `open` holds the two non-command items.
const GROUP_ORDER: readonly ('open' | CommandContextMenuGroup)[] = ['open', 'identity', 'agent', 'copy', 'close']

// Where the colour flag submenu sits inside `identity`, between Set Title
// (10) and Pin/Unpin (30/31). It is not a command, so it has no metadata to
// carry the number; keeping it here beside the group table is the one place.
const COLOR_FLAG_ORDER = 20

type Entry = { order: number; item: PopupMenuItem }

/**
 * The Sessions row menu as a serialisable template for `menu:popup`.
 *
 * `ctx` must already carry `target: request.sessionId`: every `when` below is
 * then evaluated against the clicked agent, through the same admission check
 * (`resolveCommandAvailability`) the execution gateway applies when the pick
 * runs. One predicate for "shown" and "runs" is what keeps a menu from
 * offering an item that then refuses.
 *
 * WHY built from the catalog, not a list of actions (D1): each item already
 * exists as a command with a tested `when`, a title, and a shortcut the user
 * may have rebound. A second list would need all of that again and would
 * drift the first time a provider gained or lost a capability.
 *
 * WHY the full catalog rather than the palette's picker-filtered registry:
 * hiding a command from the palette is a "don't clutter my search" preference.
 * The gateway deliberately never lets that preference disable a command
 * (executeCommand.ts), and the menu follows the same rule — only commands
 * that opted in with `contextMenu` appear here in the first place.
 */
export function buildSessionContextMenu(options: {
  request: SessionMenuRequest
  ctx: CommandContext
  /** The agent's current flag, from `settings.dispatchColorFlags`. */
  colorFlag: ColorFlagId | undefined
  /** The session Spotlight is showing now, if Spotlight is open. */
  spotlightSessionId: SessionId | null
  /** Injected for tests; the catalog by default. */
  commands?: readonly CommandDef[]
}): PopupMenuItem[] {
  const { request, ctx, colorFlag, spotlightSessionId, commands = builtInCommandCatalog } = options
  const groups = new Map<string, Entry[]>(GROUP_ORDER.map(group => [group, []]))

  if (request.showInLaneLabel) {
    groups.get('open')!.push({ order: 10, item: { type: 'item', id: SHOW_IN_LANE, label: `Show in ${request.showInLaneLabel}` } })
  }
  // Already the Spotlight agent → the item would do nothing.
  if (spotlightSessionId !== request.sessionId) {
    groups.get('open')!.push({ order: 20, item: { type: 'item', id: SPOTLIGHT, label: 'Show in Spotlight' } })
  }

  groups.get('identity')!.push({ order: COLOR_FLAG_ORDER, item: colorFlagSubmenu(colorFlag) })

  // Effective bindings once per menu, as buildCommandRegistry does per pass:
  // a user who rebound Close Agent should see THEIR chord here.
  const shortcuts = new Map(
    resolveEffectiveKeybindings(ctx.flags.commandKeybindingOverrides, buildDefaultKeybindings())
      .map(entry => [entry.commandId, entry.bindings[0]]),
  )

  for (const command of commands) {
    const placement = command.contextMenu
    if (!placement || !placementApplies(placement, request)) continue
    const availability = resolveCommandAvailability(command, ctx)
    // `hide` (the command's `when` is false for this agent) omits the item,
    // the palette's rule; it is what keeps a terminal's menu short. `disable`
    // is a command saying "this applies, but not right now, and here is why"
    // — showing it greyed is more honest than making it vanish.
    if (!availability.available && availability.presentation !== 'disable') continue
    const binding = shortcuts.get(command.id)
    const accelerator = binding ? toElectronAccelerator(binding) : null
    groups.get(placement.group)!.push({
      order: placement.order,
      item: {
        type: 'item',
        id: `${COMMAND_PREFIX}${command.id}`,
        label: placement.title ?? (typeof command.title === 'function' ? command.title(ctx) : command.title),
        ...(availability.available ? {} : { enabled: false }),
        ...(accelerator ? { accelerator } : {}),
      },
    })
  }

  const items: PopupMenuItem[] = []
  for (const group of GROUP_ORDER) {
    const entries = groups.get(group)!
    if (entries.length === 0) continue
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(...entries.sort((a, b) => a.order - b.order).map(entry => entry.item))
  }
  return items
}

function placementApplies(placement: CommandContextMenuPlacement, request: SessionMenuRequest): boolean {
  // Stop Goal Loop's `when` only checks that the agent exists (the palette
  // offers it unconditionally, and stopping nothing is harmless there). In a
  // per-agent menu an always-present "Stop Goal Loop" would read as "this
  // agent has a loop", so it is shown only while the row's loop is live.
  if (placement.requires === 'goal-loop') return request.goalLoopLive
  return true
}

/**
 * The flag choices as a submenu (D4): one step shorter than the palette's
 * picker modal, which stays for keyboard users.
 *
 * WHY "●" and names instead of colour swatches: native menu items cannot be
 * coloured, and an image per swatch is not worth the IPC shape for v1. The
 * order matches the picker, so muscle memory transfers.
 */
function colorFlagSubmenu(current: ColorFlagId | undefined): PopupMenuItem {
  return {
    type: 'submenu',
    label: 'Color Flag',
    items: [
      ...DISPATCH_COLOR_FLAGS.map((flag): PopupMenuItem => ({
        type: 'item',
        id: `${FLAG_PREFIX}${flag.id}`,
        label: `● ${flag.label}`,
        checked: current === flag.id,
      })),
      { type: 'separator' },
      { type: 'item', id: FLAG_NONE, label: 'None', checked: current === undefined },
    ],
  }
}
