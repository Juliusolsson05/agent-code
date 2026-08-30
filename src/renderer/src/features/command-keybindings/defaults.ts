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
  // `editor` is disjoint from both LAYOUT contexts as of #697:
  // activeBindingContexts drops grid/dispatch entirely while the GLOBAL EDITOR
  // owns the target, so a chord can never be matched by a layout binding and an
  // editor binding for the same keystroke.
  //
  // CONSEQUENCE worth stating, because it is a footgun: a chord filed under
  // `editor` is now reported FREE for a layout binding. That is correct for
  // chords Monaco alone owns, and WRONG for chords the OS owns in every text
  // field — those must be filed `global` or they become invisible the moment
  // this pair is declared. Cmd+Shift+Up/Down were moved for exactly that
  // reason.
  //
  // This pair is what the routing fix is FOR. Without it every dispatch chord
  // had to be unique against the whole app plus macOS plus Monaco, and two
  // attempts at a Grid Dispatch row-focus chord collided for exactly that
  // reason (Alt+Shift+Arrow with macOS word selection, Cmd+Alt+Arrow with
  // Monaco's multi-cursor). Declaring the disjointness the router now enforces
  // gives the context system back the room it was designed to provide.
  //
  // `global` is deliberately NOT disjoint from anything: it is live in every
  // surface including the editor, so a global chord really can collide.
  //
  // THIS DECLARATION IS ONLY TRUE BECAUSE OF THE ROUTER. If the gate in
  // activeBindingContexts is ever removed, this list becomes a lie and
  // check:keybindings will happily approve chords that really do conflict. The
  // gate is pinned by `bindingContexts.test.ts` ("drops the layout context
  // entirely while the Global Editor owns the target") — that test failing
  // means this list must change too, not that the test needs updating.
  //
  // That guard is ONE-DIRECTIONAL and it is worth knowing which direction. It
  // pins the pure context map. It does NOT pin the `editorOwnsTarget` DOM
  // predicate or the call-site wiring, so a regression in either would keep the
  // test green while making this list false.
  ['grid', 'editor'],
  ['dispatch', 'editor'],
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

    // --- Windows ------------------------------------------------------------
    // ⌘⇧N is the platform convention for New Window (Finder, Safari, VS Code),
    // and nothing in this app claims it. Note that `check:keybindings` only
    // knows THIS app's bindings — it cannot tell you a chord is free of macOS
    // system reservations — but ⌘⇧N is reserved by no system service, only by
    // other applications for this exact action.
    { commandId: 'new-window', bindings: ['Cmd+Shift+N'], context: 'global' },

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
    // 'global', NOT 'grid'. These create commands work in BOTH modes —
    // splitFocused spawns a detached agent in Dispatch — and a 'grid' context
    // meant the chord did not even resolve there. Before keybinds routed through
    // the binding table these were hard-coded branches that the Dispatch handler
    // fell through to, so ⌥D/⌥T fired in Dispatch for the entire life of the
    // app until that routing landed. This restores it.
    //
    // Safe against the Dispatch reservations: those claim ⌥ arrows and ⌥HJKL
    // only, and check:keybindings enforces that.
    { commandId: 'split-vertical', bindings: ['Alt+D'], context: 'global' },
    { commandId: 'split-horizontal', bindings: ['Alt+Shift+D'], context: 'global' },
    { commandId: 'terminal-horizontal', bindings: ['Alt+T'], context: 'global' },
    { commandId: 'terminal-vertical', bindings: ['Alt+Shift+T'], context: 'global' },

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
    // ⌘, is the macOS convention for Settings and was unclaimed.
    { commandId: 'open-settings', bindings: ['Cmd+,'], context: 'global' },

    // ========================================================================
    // USAGE-DERIVED DEFAULTS
    //
    // Everything above this line is a chord that ALREADY RAN before the
    // governance work — the table was kept deliberately scarce so upgrading
    // users lost no muscle memory, and the governance plan explicitly refused
    // to mint defaults from palette-usage counts, on the grounds that history
    // "came from one development profile" and proves a command is USEFUL, not
    // that it deserves a scarce global chord.
    //
    // This block is a considered departure from that, not an oversight. What
    // changed is the evidence: the recent-command cache now covers 2,674
    // recorded invocations, and the thirteen commands below account for 1,703
    // of them — roughly 64% of everything invoked — while having no chord at
    // all. "Scarce" was protecting against speculative bindings. These are the
    // opposite: the most-used surface in the app, reachable only by opening a
    // palette and typing.
    //
    // The caveat that keeps this honest: until the execution gateway landed,
    // ONLY the palette recorded a use. So these counts are palette selections,
    // which systematically UNDER-counts anything already bound (close-pane
    // shows 1). That biases the data in the safe direction here — every
    // command below is unbound, so its count is complete, and no bound command
    // was displaced on the strength of a number that undercounts it.
    //
    // THE FAMILIES. Assigned so the set is learnable rather than memorized;
    // a thirteen-chord dump with no scheme is thirteen things to forget.
    //
    //   ⌘  + letter  — layout and app-level panels, beside ⌘T/⌘W/⌘P
    //   ⌘⌥ + letter  — developer tooling, beside Electron's ⌘⌥I devtools
    //   ⌥  + letter  — pane and session verbs, beside ⌥D/⌥T/⌥C splits
    //   ⌥⇧ + letter  — the HEAVIER sibling of the ⌥ verb below it
    //
    // The ⌥/⌥⇧ pairing is the part worth preserving when this list grows:
    // ⌥A soft-reloads an agent, ⌥⇧A hard-reloads it; ⌥P opens the template
    // picker, ⌥⇧P opens the prompt history. Shift means "more of the same
    // thing", never "an unrelated command that happened to fit".

    // --- Layout modes (⌘) ---------------------------------------------------
    // These two SHOULD have been ⌘D → ⌘⇧D, base → tiled variant, matching the
    // shift-means-more rule used everywhere else in this block. They are not,
    // because ⌘⇧D is the voice dictation hotkey (DEFAULT_SETTINGS
    // .dictationShortcut) and `check:keybindings` rejected the pairing.
    //
    // Worth recording HOW that was caught, because it nearly was not: the
    // chords in this block were probed against `findBindingOwners` before
    // being written, and that probe passed — it omitted `dictationBinding`,
    // which is optional on the options object. The check script passes it. So
    // the gate caught a real collision that a hand-rolled call to the very
    // same function had missed. If you are adding chords here, run
    // `npm run check:keybindings`; do not trust a bespoke probe.
    //
    // Given the constraint, the higher-usage command takes the better chord:
    // Tiled Dispatch (164) gets bare ⌘D, Dispatch Mode (52) gets ⌘⇧M for Mode.
    // The pair is less elegant than ⌘D/⌘⇧D would have been, and that is the
    // correct trade — an elegant scheme that shadows dictation is not elegant.
    { commandId: 'tiled-dispatch', bindings: ['Cmd+D'], context: 'global' },
    { commandId: 'dispatch-mode', bindings: ['Cmd+Shift+M'], context: 'global' },
    // `dispatch` context, not global: Dispatch Scope only means anything while
    // Dispatch owns the layout, and scoping it here leaves ⌘⇧G free for a grid
    // command later. The overlap matrix proves grid and dispatch are disjoint.
    { commandId: 'global-dispatch', bindings: ['Cmd+Shift+G'], context: 'dispatch' },
    // Grid Dispatch row focus (#681) ships with NO default binding.
    //
    // ⌥⇧↑/↓ was the obvious pair — it reads as "same axis, bigger unit" beside
    // the existing ⌥↑/↓ — and check:keybindings accepted it, because that
    // checker only knows about bindings this app registers. It does not know
    // about the OS. useKeybinds' header already records why that matters:
    // Option+Shift+Arrow is the macOS word-selection shortcut and is
    // "load-bearing for every text field in the app (including our composer)",
    // which is exactly why directional resize uses fn+alt+Arrow instead.
    //
    // Dispatch bindings stay active while a text editor owns the target, and
    // the router preventDefault()s what it routes, so claiming that chord would
    // have broken selection in the composer while moving row focus underneath
    // the user.
    //
    // Grid Dispatch row focus. This chord took three attempts and the first two
    // are worth keeping written down, because both were "verified free" against
    // a source that could not see the real owner:
    //
    //   Alt+Shift+Arrow  — macOS word selection. check:keybindings passed; it
    //                      does not know about the OS.
    //   Cmd+Alt+Arrow    — Monaco's Add Cursor Above/Below. Its `linux:` block
    //                      overrides Linux only, so `primary` applies on mac.
    //                      Those chords are now in RESERVED_INTERACTIONS.
    //
    // Cmd+Alt+Arrow is legal NOW, and only because #697 made `dispatch` stop
    // being live while a text editor owns the target. Monaco still owns this
    // chord inside the editor and always will — the two no longer compete,
    // because they are never live at the same time. That disjointness is
    // declared in DISJOINT_CONTEXT_PAIRS above and enforced by the router.
    //
    // If that gate is ever removed, this binding becomes a real conflict again.
    { commandId: 'dispatch-focus-row-up', bindings: ['Cmd+Alt+Up'], context: 'dispatch' },
    { commandId: 'dispatch-focus-row-down', bindings: ['Cmd+Alt+Down'], context: 'dispatch' },

    // --- App panels (⌘⇧) ----------------------------------------------------
    { commandId: 'usage.open', bindings: ['Cmd+Shift+U'], context: 'global' },

    // --- Developer tooling (⌘⌥) ---------------------------------------------
    // The single most-invoked command in the cache (352), and it sits on ⌘⌥
    // rather than ⌘⇧ deliberately: that is where Electron already puts
    // devtools (⌘⌥I), so the debug surface stays in one modifier family
    // instead of competing with product panels for ⌘⇧ letters.
    { commandId: 'toggle-debug-panel', bindings: ['Cmd+Alt+D'], context: 'global' },

    // --- Pane and session verbs (⌥) -----------------------------------------
    // Reader Mode is the strongest single case in this whole block. Escape
    // already CLOSES it (useKeybinds' one-key dismiss), but nothing opened it
    // — an asymmetry that cost 156 palette round-trips for a toggle.
    { commandId: 'toggle-reader-mode', bindings: ['Alt+R'], context: 'global' },
    { commandId: 'toggle-spotlight', bindings: ['Alt+S'], context: 'global' },
    // ⌥F, leaving ⌥⇧F open for Auto-follow ALL Visible Agents — the same
    // soft/heavy pairing, and the command that OWNS the effective state when
    // both are on (see the `detail` on toggle-tail's state).
    { commandId: 'toggle-tail', bindings: ['Alt+F'], context: 'global' },
    // ⌥V and ⌥P open pickers rather than acting directly, so the chord saves
    // the palette search and not the decision. They are here on volume alone
    // (315 and 121). If `set-agent-view-mode` is ever split into three direct
    // commands — Agent / Terminal / Default — ⌥V should follow the one that
    // gets used, and this entry should go.
    { commandId: 'set-agent-view-mode', bindings: ['Alt+V'], context: 'global' },
    { commandId: 'prompt-template', bindings: ['Alt+P'], context: 'global' },

    // --- Heavier siblings (⌥⇧) ----------------------------------------------
    // Soft reload is the lighter action and takes the lighter chord. Note the
    // counts run the other way (136 hard vs 62 soft): the modifier tracks
    // BLAST RADIUS, not frequency, because the cost of hitting the wrong one
    // is asymmetric.
    { commandId: 'soft-reload-agent', bindings: ['Alt+A'], context: 'global' },
    { commandId: 'reload-agent', bindings: ['Alt+Shift+A'], context: 'global' },
    { commandId: 'view-prompts', bindings: ['Alt+Shift+P'], context: 'global' },

    // --- The reference sheet ------------------------------------------------
    // ⌘⇧/ is ⌘? on a US layout, the long-standing platform chord for "show me
    // the shortcuts". Slack, GitHub and Gmail all land on ? for the same
    // reason, and macOS puts Help search on ⌘⇧/ system-wide.
    //
    // This one is NOT usage-derived — the command did not exist when the cache
    // was recorded. It is bound on a different argument: a shortcut list that
    // can only be reached by remembering a shortcut is a joke, and reached by
    // opening the palette and typing "keyboard" is nearly as bad, because the
    // palette is exactly what a user falls back to WHEN they have forgotten the
    // chord. The sheet has to be the one chord worth memorizing.
    { commandId: 'open-keyboard-shortcuts', bindings: ['Cmd+Shift+/'], context: 'global' },
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
      // 'global' for the same reason as the generic splits above.
      { commandId: `${kind}-vertical`, bindings: [`Alt+${chord}`], context: 'global' },
      { commandId: `${kind}-horizontal`, bindings: [`Alt+Shift+${chord}`], context: 'global' },
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
