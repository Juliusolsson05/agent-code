import { contextsOverlap } from '@renderer/features/command-keybindings/defaults'
import type { BindingContext, CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'
import { tryNormalizeKeybinding } from '@renderer/features/command-keybindings/normalize'
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
    // Monaco's multi-cursor and column-select chords, verified against
    // node_modules/monaco-editor (multicursor.js / coreCommands.js) rather than
    // from memory.
    //
    // WHY these were missing and why it mattered: Grid Dispatch's row-focus
    // commands were given Cmd+Alt+Up/Down, the app-side checker passed because
    // nothing in this table claimed them, and review found they are Monaco's
    // "Add Cursor Above/Below". The `linux:` override in that file replaces the
    // chord on Linux only, so `primary` — CtrlCmd|Alt|Arrow — is what applies on
    // macOS. `dispatch` and `editor` are NOT in DISJOINT_CONTEXT_PAIRS, so with
    // this entry present the checker now rejects that pairing instead of
    // offering it as free.
    //
    // This is exactly the "incomplete list" failure the header above warns
    // about, and it has now happened once.
    bindings: [
      'Cmd+Alt+Up', 'Cmd+Alt+Down',
      'Cmd+Alt+Shift+Up', 'Cmd+Alt+Shift+Down',
      'Cmd+Alt+Shift+Left', 'Cmd+Alt+Shift+Right',
      'Cmd+Shift+Up', 'Cmd+Shift+Down',
    ],
    context: 'editor',
    owner: 'Monaco multi-cursor / column select',
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
    //
    // These are the accelerators Electron installs IMPLICITLY from a role.
    // `appMenu.ts` only names roles (`appMenu`, `editMenu`, `close`,
    // `forceReload`, `togglefullscreen`, `windowMenu`), so the chords never
    // appear as literals anywhere in this repository and have to be
    // transcribed from Electron's role table. An earlier version of this list
    // was transcribed from the visible source instead and was therefore
    // materially short — it reported Cmd+- and Cmd+Shift+R as free.
    bindings: [
      'Cmd+Q', 'Cmd+H', 'Cmd+M', 'Cmd+R', 'Cmd+0', 'Cmd+Alt+I',
      // role: 'close' — Close Window. Note this makes Cmd+W THREE-way owned
      // (close-pane, editor-native close file, Close Window), which the
      // approved-overlap entry below now records explicitly.
      'Cmd+W',
      // role: 'forceReload'
      'Cmd+Shift+R',
      // role: 'appMenu' → Hide Others
      'Cmd+Alt+H',
      // role: 'togglefullscreen'
      'Cmd+Ctrl+F',
      // Explicit zoom accelerators in appMenu.ts's View submenu. Electron
      // spells zoom-in 'CommandOrControl+Plus'; the physical key is '=', which
      // is the token this grammar uses.
      'Cmd+=', 'Cmd+-',
    ],
    context: 'global',
    owner: 'Native application menu',
  },
  {
    bindings: [
      'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+A', 'Cmd+Z', 'Cmd+Shift+Z',
      // role: 'editMenu' → Paste and Match Style
      'Cmd+Alt+Shift+V',
    ],
    context: 'global',
    owner: 'Native editing commands',
  },
  {
    // Tiled-tab resize CONTINUATION. After Cmd+N focuses a tiled tab, arrows
    // held under Cmd resize it (useKeybinds' pendingTiledResizeIndex). Stateful
    // and therefore easy to miss when transcribing owners: the chord only does
    // anything in the window between Cmd+N and releasing Cmd, but during that
    // window it beats anything else bound to the same keys.
    bindings: ['Cmd+Left', 'Cmd+Right', 'Cmd+Up', 'Cmd+Down'],
    context: 'global',
    owner: 'Tiled tab resize (after numbered selection)',
  },
  {
    // The agent pane IS a terminal, and these go to the process, not to us.
    //
    // `useKeybinds` bails whenever a terminal owns input, so a command bound to
    // Ctrl+C would render in Settings with a chord and then never fire in the
    // one place users spend their time. That is the same "appears bound, does
    // nothing" failure the native-menu roles above are listed to prevent, and
    // it belongs in the same table for the same reason: the conflict checker
    // can only warn about owners it has been told exist.
    //
    // 'global' rather than a terminal context because there is no such context
    // — and inventing one would be worse than this slight over-reservation:
    // these chords have universal terminal meanings, and handing one to an app
    // command would be surprising even where it technically could fire.
    bindings: ['Ctrl+C', 'Ctrl+D', 'Ctrl+Z', 'Ctrl+A', 'Ctrl+E', 'Ctrl+U', 'Ctrl+W'],
    context: 'global',
    owner: 'Terminal / agent process (SIGINT, EOF, and readline editing)',
  },
  {
    // Feed picker navigation. While the Copy Assistant or Copy Code Block
    // picker owns input, these four keys move/confirm/cancel the selection.
    bindings: ['Up', 'Down', 'Enter'],
    context: 'feed',
    owner: 'Assistant / code-block picker navigation',
  },
  {
    // Editor chrome owns all FOUR of these while focus is inside
    // [data-global-editor-input-owner] — useKeybinds bails for
    // ['s','w','[',']'] there. Only Cmd+W was declared originally, which left
    // Cmd+[ / Cmd+] (Monaco outdent/indent) reported as free the moment a user
    // rebound next-tab/prev-tab away from them. Binding a global command to a
    // freed bracket would produce a chord that silently does nothing whenever
    // the editor has focus — the exact silent-conflict failure this file's
    // docstring warns about.
    bindings: ['Cmd+W', 'Cmd+[', 'Cmd+]'],
    context: 'editor',
    owner: 'Editor-native close file and indentation',
  },
  {
    // Editor file-tab strip: Delete closes, arrows/Home/End move between tabs.
    bindings: ['Delete', 'Left', 'Right', 'Home', 'End'],
    context: 'editor',
    owner: 'Editor file-tab navigation',
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
    owners: ['close-pane', 'Editor-native close file and indentation', 'Native application menu'],
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
      + '(useKeybinds bails out for editor-owned targets), and the renderer '
      + 'preventDefaults it so Electron\'s Close Window role never receives it. '
      + 'Exactly one owner is live for a given focus.',
  },
  {
    binding: 'Cmd+[',
    owners: ['prev-tab', 'Editor-native close file and indentation'],
    reason:
      'useKeybinds returns early for Cmd+[ whenever the event target sits '
      + 'inside [data-global-editor-input-owner], so Monaco outdent and tab '
      + 'navigation are never both live for one focus.',
  },
  {
    binding: 'Cmd+]',
    owners: ['next-tab', 'Editor-native close file and indentation'],
    reason:
      'useKeybinds returns early for Cmd+] whenever the event target sits '
      + 'inside [data-global-editor-input-owner], so Monaco indent and tab '
      + 'navigation are never both live for one focus.',
  },
  {
    binding: 'End',
    owners: ['jump-latest-message', 'Editor file-tab navigation'],
    reason:
      'Jump to Latest Message requires a focused rendered feed and a target '
      + 'that is not text-editing, while editor tab navigation requires focus '
      + 'inside editor chrome. The two preconditions cannot hold at once.',
  },
  {
    binding: 'Cmd+Shift+R',
    owners: ['resume-session', 'Native application menu'],
    // Pre-existing in the app, not introduced here: resume-session has shipped
    // on Cmd+Shift+R for a long time, and appMenu's `forceReload` role carries
    // the same accelerator implicitly. The renderer's capture-phase handler
    // calls preventDefault before the menu's accelerator path runs, so Force
    // Reload is effectively shadowed rather than racing.
    //
    // Recorded rather than silently tolerated because it is exactly the kind
    // of overlap that looks fine until someone unbinds resume-session and
    // discovers Cmd+Shift+R now force-reloads the app mid-session.
    reason:
      'The renderer capture handler preventDefaults Cmd+Shift+R before '
      + 'Electron\'s forceReload role accelerator can fire, so the command '
      + 'shadows the native role deterministically rather than racing it.',
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
  const dictation = normalizeDictationBinding(options.dictationBinding)
  if (dictation) {
    claim(dictation, {
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

  if (normalizeDictationBinding(options.dictationBinding) === options.binding) {
    owners.push({ kind: 'reserved', id: 'Voice dictation hotkey', context: 'global' })
  }

  return owners
}

/**
 * Bring a dictation hotkey into the command grammar before comparing it.
 *
 * WHY this is not a raw string compare: dictation captures and persists its own
 * notation, and `hotkeyBinding.ts` deliberately rewrites `Alt` to `Option` for
 * display — so a user who binds Option-D has `"Option+D"` in settings while the
 * command grammar canonicalizes the identical physical chord to `"Alt+D"`.
 * Comparing raw strings found no collision between two bindings that register
 * the SAME key, which is precisely the clash this engine exists to catch. Once
 * runtime routing lands, that would mean pressing Option-D starts dictation and
 * runs a command.
 *
 * The normalizer already accepts `option` as an alias for Alt, so this is just
 * a matter of running it. Returns null for an unparseable value rather than
 * throwing: an exotic dictation binding must not be able to break collision
 * checking for every other chord.
 */
function normalizeDictationBinding(binding: Keybinding | null | undefined): Keybinding | null {
  return binding ? tryNormalizeKeybinding(binding) : null
}
