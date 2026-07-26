import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { normalizeKeybinding } from '@renderer/features/command-keybindings/normalize'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'

/**
 * Where a binding is allowed to fire.
 *
 * WHY contexts exist at all: without them the collision checker cannot tell
 * genuinely disjoint behavior from an accidental duplicate. ⌥K really does
 * focus a grid pane AND move the Dispatch selection — those never coexist, so
 * it is one gesture with two meanings, not a conflict. But ⌘S in the editor and
 * a hypothetical app-wide ⌘S DO coexist, so that is a real clash.
 *
 * The user never picks a context. The command contract supplies it. Exposing it
 * as a user-editable field would be an escape hatch for declaring any conflict
 * safe, which is exactly the "different surface means it's fine" reasoning the
 * plan forbids.
 */
export type BindingContext =
  /** Fires anywhere the workspace router runs. */
  | 'global'
  /** Only while the tile grid owns the layout. */
  | 'grid'
  /** Only while Dispatch owns the layout. */
  | 'dispatch'
  /** Only while Global Editor chrome owns focus. */
  | 'editor'
  /** Only while a rendered feed is focused and the target is not text editing. */
  | 'feed'

/**
 * The CLOSED overlap matrix. Two bindings may share a chord only if their
 * contexts appear here as non-overlapping.
 *
 * Deliberately an allow-list of DISJOINT pairs rather than a rule engine: the
 * only genuinely mutually exclusive pair today is grid/dispatch, because they
 * are two states of one layout switch. Everything else can be simultaneously
 * live — the editor overlays the workspace, the feed sits inside a pane, and
 * global is by definition everywhere. Encoding that as data rather than as a
 * predicate means adding a new context forces someone to state its
 * relationships explicitly instead of inheriting a permissive default.
 */
const DISJOINT_CONTEXT_PAIRS: ReadonlyArray<readonly [BindingContext, BindingContext]> = [
  ['grid', 'dispatch'],
]

export function contextsOverlap(a: BindingContext, b: BindingContext): boolean {
  if (a === b) return true
  return !DISJOINT_CONTEXT_PAIRS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  )
}

export type CommandBindingDefault = {
  commandId: string
  bindings: readonly Keybinding[]
  context: BindingContext
}

/**
 * The shipped default binding set.
 *
 * INTENTIONALLY SCARCE. This preserves the muscle memory that already exists,
 * fills the metadata gaps the Phase 0 baseline recorded, and adds exactly one
 * new chord (⌘, for Settings, the platform convention). It does NOT mint
 * defaults from personalized palette-usage counts: that history is
 * picker-only and came from one development profile, so it is evidence that a
 * command is USEFUL, not a mandate to spend a scarce global chord on it.
 *
 * Every entry here is either (a) a chord that already ran before this change,
 * or (b) ⌘, — so upgrading users lose nothing and gain one conventional key.
 * The aliases the palette never advertised (⌥W, the ⌥Arrow navigation pairs)
 * are declared explicitly, because the whole point is that the displayed
 * binding and the running binding are now the same fact.
 */
export function buildDefaultKeybindings(): CommandBindingDefault[] {
  const defaults: CommandBindingDefault[] = [
    // --- Command access -----------------------------------------------------
    // Previously hard-coded as `onCommandPalette?.()` with no command id, which
    // is why it could not be rebound. Phase 4 gives it an owner.
    { commandId: 'open-command-palette', bindings: ['Cmd+Shift+P'], context: 'global' },

    // --- Tabs ---------------------------------------------------------------
    { commandId: 'new-tab', bindings: ['Cmd+T'], context: 'global' },
    { commandId: 'close-tab', bindings: ['Cmd+Shift+W'], context: 'global' },
    { commandId: 'undo-close', bindings: ['Cmd+Shift+T'], context: 'global' },
    { commandId: 'resume-session', bindings: ['Cmd+Shift+R'], context: 'global' },
    { commandId: 'prev-tab', bindings: ['Cmd+['], context: 'global' },
    { commandId: 'next-tab', bindings: ['Cmd+]'], context: 'global' },

    // --- Pane lifecycle -----------------------------------------------------
    // ⌥W was live but never advertised: an undisclosed destructive chord. It is
    // preserved (removing a working binding is a regression) but now declared,
    // so Settings can show it and a user can unbind it.
    { commandId: 'close-pane', bindings: ['Cmd+W', 'Alt+W'], context: 'global' },

    // --- Creation -----------------------------------------------------------
    { commandId: 'split-vertical', bindings: ['Alt+D'], context: 'grid' },
    { commandId: 'split-horizontal', bindings: ['Alt+Shift+D'], context: 'grid' },
    { commandId: 'terminal-horizontal', bindings: ['Alt+T'], context: 'grid' },
    { commandId: 'terminal-vertical', bindings: ['Alt+Shift+T'], context: 'grid' },

    // --- Navigation ---------------------------------------------------------
    // The four ⌥Arrow aliases were live and undeclared. Note these are `grid`
    // context: the same physical gestures move the Dispatch selection, which is
    // a separate reserved interaction, and the overlap matrix proves the two
    // can never both be live.
    { commandId: 'nav-left', bindings: ['Alt+H', 'Alt+Left'], context: 'grid' },
    { commandId: 'nav-right', bindings: ['Alt+L', 'Alt+Right'], context: 'grid' },
    { commandId: 'nav-up', bindings: ['Alt+K', 'Alt+Up'], context: 'grid' },
    { commandId: 'nav-down', bindings: ['Alt+J', 'Alt+Down'], context: 'grid' },

    // --- Editor -------------------------------------------------------------
    // ⌘⇧E ran with no declared metadata at all — the palette showed this row
    // with no chord even though one existed.
    { commandId: 'toggle-global-editor', bindings: ['Cmd+Shift+E'], context: 'global' },
    { commandId: 'quick-open-file', bindings: ['Cmd+P'], context: 'global' },
    { commandId: 'search-in-files', bindings: ['Cmd+Shift+F'], context: 'global' },
    { commandId: 'toggle-editor-fullscreen', bindings: ['Cmd+Alt+E'], context: 'global' },
    // Editor context specifically. Today this chord is implemented TWICE in the
    // editor (Monaco addAction + the EditorWorkbench bubble handler) and never
    // reaches the command. Declaring it here is what makes rebinding possible;
    // removing those two hard-coded paths is what makes rebinding real.
    { commandId: 'save-editor-file', bindings: ['Cmd+S'], context: 'editor' },

    // --- Feed ---------------------------------------------------------------
    // Bare End, guarded by "not text editing" — hence its own context rather
    // than 'global', or it would collide with End inside any composer.
    { commandId: 'jump-latest-message', bindings: ['End'], context: 'feed' },

    // --- Preferences --------------------------------------------------------
    // The one genuinely NEW default. ⌘, is the macOS convention for Settings
    // and was unclaimed.
    { commandId: 'open-settings', bindings: ['Cmd+,'], context: 'global' },
  ]

  // Per-provider split chords, derived from the SAME provider identity
  // descriptors that generate the commands themselves (paneCommands.ts). This
  // is the one chord family that already had a single source of truth, and
  // keeping it derived means adding a provider cannot leave metadata and
  // behavior disagreeing. Codex declares 'C' → ⌥C/⌥⇧C; OpenCode declares no
  // key and therefore ships unbound, which is a deliberate scarcity choice
  // rather than an oversight.
  for (const kind of AGENT_PROVIDER_KINDS) {
    if (kind === DEFAULT_PROVIDER) continue
    const chord = getRendererProviderCapabilities(kind).splitShortcutKey
    if (!chord) continue
    defaults.push(
      { commandId: `${kind}-vertical`, bindings: [`Alt+${chord}`], context: 'grid' },
      { commandId: `${kind}-horizontal`, bindings: [`Alt+Shift+${chord}`], context: 'grid' },
    )
  }

  // Normalize on the way out so an authoring typo here fails at module load in
  // the test suite rather than producing a binding that silently never matches.
  return defaults.map(entry => ({
    ...entry,
    bindings: entry.bindings.map(normalizeKeybinding),
  }))
}

/** Lookup of shipped defaults by command id. */
export function defaultKeybindingsByCommand(): Map<string, CommandBindingDefault> {
  return new Map(buildDefaultKeybindings().map(entry => [entry.commandId, entry]))
}
