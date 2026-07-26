import { contextsOverlap } from '@renderer/features/command-keybindings/defaults'
import type { BindingContext, CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'

// ---------------------------------------------------------------------------
// Reserved interactions and the collision engine.
//
// "Keybind control of all commands" does NOT mean turning every keyboard
// interaction into a command. Escape dismissal, modal and picker navigation,
// composer editing, numbered tab/Dispatch selection, split resizing, and
// editor-native tab behavior stay contextual interactions — they have no
// meaningful palette row, and inventing one for each would produce dozens of
// fake commands whose only purpose is to make a file shorter.
//
// But they still have to participate in collision checking, or a user could
// assign a command on top of Escape and silently break every modal in the app.
// So they are declared here as RESERVATIONS: things that own a chord without
// being commands.
// ---------------------------------------------------------------------------

export type ReservedInteraction = {
  /** Chords this interaction owns. */
  bindings: readonly Keybinding[]
  context: BindingContext
  /** Shown to the user when their capture collides with this. */
  owner: string
}

/**
 * Every non-command owner of a chord.
 *
 * WHY these are enumerated rather than discovered: they live in handlers spread
 * across useKeybinds, Monaco, Electron's native roles, and individual modals.
 * Nothing can derive them. An incomplete list here is the failure mode to
 * watch — a chord that is really taken but absent from this table would be
 * offered to the user as free, and the resulting conflict would be silent.
 */
export const RESERVED_INTERACTIONS: readonly ReservedInteraction[] = [
  {
    // Indexed tab activation, and Dispatch's two-digit row grammar which
    // reuses the same digits while Dispatch owns the layout.
    bindings: ['Cmd+1', 'Cmd+2', 'Cmd+3', 'Cmd+4', 'Cmd+5', 'Cmd+6', 'Cmd+7', 'Cmd+8', 'Cmd+9'],
    context: 'global',
    owner: 'Numbered tab / Dispatch row selection',
  },
  {
    bindings: [
      'Cmd+Alt+1', 'Cmd+Alt+2', 'Cmd+Alt+3', 'Cmd+Alt+4', 'Cmd+Alt+5',
      'Cmd+Alt+6', 'Cmd+Alt+7', 'Cmd+Alt+8', 'Cmd+Alt+9',
    ],
    context: 'global',
    owner: 'Numbered tab activation (Dispatch-safe variant)',
  },
  {
    // Dispatch row/lane movement. Mutually exclusive with the grid navigation
    // COMMANDS that share these chords — that disjointness is exactly what the
    // overlap matrix encodes, and why this is legal rather than a conflict.
    bindings: ['Alt+Up', 'Alt+Down', 'Alt+Left', 'Alt+Right', 'Alt+J', 'Alt+K', 'Alt+H', 'Alt+L'],
    context: 'dispatch',
    owner: 'Dispatch row and lane selection',
  },
  {
    bindings: ['Alt+=', 'Alt+-'],
    context: 'global',
    owner: 'Split resize',
  },
  {
    // Fn+Option+Arrow arrives as Option + Home/End/PageUp/PageDown, because
    // macOS translates Fn before the event reaches the app.
    bindings: ['Alt+Home', 'Alt+End', 'Alt+PageUp', 'Alt+PageDown'],
    context: 'global',
    owner: 'Directional split resize',
  },
  {
    bindings: ['Escape'],
    context: 'global',
    owner: 'Dismiss modal, picker, Spotlight, Reader, or fullscreen',
  },
  {
    // Standard Electron menu roles. Assigning a command on top of one of these
    // does not merely conflict — the native menu wins, so the command would
    // appear bound and simply never fire.
    bindings: ['Cmd+Q', 'Cmd+H', 'Cmd+M', 'Cmd+R', 'Cmd+0', 'Cmd+Alt+I'],
    context: 'global',
    owner: 'Native application menu',
  },
  {
    bindings: ['Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+A', 'Cmd+Z', 'Cmd+Shift+Z'],
    context: 'global',
    owner: 'Native editing commands',
  },
  {
    // Monaco owns Cmd+W for closing a file tab while editor chrome has focus.
    // Note Cmd+W is ALSO a close-pane command binding in 'global' context —
    // those contexts overlap, so this is a real conflict that the app resolves
    // by precedence today. Declared so the checker reports it rather than
    // pretending the chord is free.
    bindings: ['Cmd+W'],
    context: 'editor',
    owner: 'Editor-native close file',
  },
]

export type BindingOwnerRef = {
  kind: 'command' | 'reserved'
  /** Command id, or the reserved interaction's owner label. */
  id: string
  context: BindingContext
}

/**
 * Overlaps that are DELIBERATE and already resolved by a documented precedence
 * rule, rather than by registration order.
 *
 * The plan permits reuse only when the pair is "explicitly characterized", so
 * this is that characterization — one entry, with the reason it is safe. It is
 * intentionally awkward to add to: an approved overlap is a promise that some
 * handler resolves the ambiguity before either owner runs, and that promise has
 * to be true.
 *
 * WHY the entries are keyed by owner PAIR and not just by chord: approving
 * "⌘W is fine" would silently bless a third owner appearing later. Approving
 * "⌘W between these two specific owners" does not.
 */
const APPROVED_OVERLAPS: ReadonlyArray<{
  binding: Keybinding
  owners: readonly string[]
  reason: string
}> = [
  {
    binding: 'Cmd+W',
    owners: ['close-pane', 'Editor-native close file'],
    // Resolved by focus, deterministically and before either owner runs:
    // useKeybinds returns early for cmd+s/w/[/] whenever the event target is
    // inside [data-global-editor-input-owner], so the workspace's close-pane
    // handler cannot fire while editor chrome has focus. EditorWorkbench then
    // consumes it in bubble phase (and Monaco does inside the text area).
    //
    // This is a real product decision, not an accident: an empty workbench must
    // still swallow ⌘W, because otherwise Electron's native menu receives the
    // unhandled chord and closes the whole window.
    reason:
      'Editor chrome consumes Cmd+W before the workspace router sees it '
      + '(useKeybinds bails out for editor-owned targets), so exactly one owner '
      + 'is ever live for a given focus.',
  },
]

function isApprovedOverlap(binding: Keybinding, owners: readonly BindingOwnerRef[]): boolean {
  const ids = owners.map(o => o.id).sort()
  return APPROVED_OVERLAPS.some(
    approved =>
      approved.binding === binding &&
      approved.owners.length === ids.length &&
      [...approved.owners].sort().every((id, index) => id === ids[index]),
  )
}

/** The approved overlaps, exposed so Settings and the repository script can
 *  explain why a chord that looks doubly-claimed is intentional. */
export function listApprovedOverlaps(): typeof APPROVED_OVERLAPS {
  return APPROVED_OVERLAPS
}

export type BindingCollision = {
  binding: Keybinding
  owners: readonly BindingOwnerRef[]
}

/**
 * Find every chord claimed by two owners whose contexts can be live at once.
 *
 * Registration order, last-write-wins and silent precedence are all forbidden
 * by the plan: whichever owner "wins" today is an accident of file order, and
 * an accident is not a policy. This returns the clash so a human decides.
 *
 * `dictationBinding` is threaded in rather than imported because the static
 * repository script checks the SHIPPED default while Settings must check the
 * CURRENT PROFILE's value — same function, two different inputs. Importing the
 * settings store here would make the script impossible to run.
 */
export function findBindingCollisions(options: {
  commandDefaults: readonly CommandBindingDefault[]
  reserved?: readonly ReservedInteraction[]
  dictationBinding?: Keybinding | null
}): BindingCollision[] {
  const reserved = options.reserved ?? RESERVED_INTERACTIONS
  const claims = new Map<Keybinding, BindingOwnerRef[]>()

  const claim = (binding: Keybinding, owner: BindingOwnerRef) => {
    const existing = claims.get(binding)
    if (existing) existing.push(owner)
    else claims.set(binding, [owner])
  }

  for (const entry of options.commandDefaults) {
    for (const binding of entry.bindings) {
      claim(binding, { kind: 'command', id: entry.commandId, context: entry.context })
    }
  }
  for (const entry of reserved) {
    for (const binding of entry.bindings) {
      claim(binding, { kind: 'reserved', id: entry.owner, context: entry.context })
    }
  }
  if (options.dictationBinding) {
    claim(options.dictationBinding, {
      kind: 'reserved',
      id: 'Voice dictation hotkey',
      context: 'global',
    })
  }

  const collisions: BindingCollision[] = []
  for (const [binding, owners] of claims) {
    if (owners.length < 2) continue
    // Only report pairs whose contexts can actually be live simultaneously.
    // ⌥K focusing a grid pane and ⌥K moving the Dispatch selection is one
    // gesture with two meanings, not a bug.
    const overlapping = owners.filter((owner, index) =>
      owners.some((other, otherIndex) =>
        index !== otherIndex && contextsOverlap(owner.context, other.context),
      ),
    )
    if (overlapping.length < 2) continue
    // A deliberate, documented overlap is not a defect. Anything else is.
    if (isApprovedOverlap(binding, overlapping)) continue
    collisions.push({ binding, owners: overlapping })
  }

  return collisions.sort((a, b) => a.binding.localeCompare(b.binding))
}

/**
 * Who already owns this chord, for the Settings capture UI.
 *
 * Returns every overlapping owner so the error can NAME them. "That shortcut is
 * taken" is not actionable; "⌘S is used by Save Editor File" is.
 */
export function findBindingOwners(options: {
  binding: Keybinding
  context: BindingContext
  commandDefaults: readonly CommandBindingDefault[]
  reserved?: readonly ReservedInteraction[]
  dictationBinding?: Keybinding | null
  /** Ignore this command's own claims, so re-saving an unchanged binding is not
   *  reported as conflicting with itself. */
  excludeCommandId?: string
}): BindingOwnerRef[] {
  const reserved = options.reserved ?? RESERVED_INTERACTIONS
  const owners: BindingOwnerRef[] = []

  for (const entry of options.commandDefaults) {
    if (entry.commandId === options.excludeCommandId) continue
    if (!entry.bindings.includes(options.binding)) continue
    if (!contextsOverlap(entry.context, options.context)) continue
    owners.push({ kind: 'command', id: entry.commandId, context: entry.context })
  }

  for (const entry of reserved) {
    if (!entry.bindings.includes(options.binding)) continue
    if (!contextsOverlap(entry.context, options.context)) continue
    owners.push({ kind: 'reserved', id: entry.owner, context: entry.context })
  }

  if (options.dictationBinding === options.binding) {
    owners.push({ kind: 'reserved', id: 'Voice dictation hotkey', context: 'global' })
  }

  return owners
}
