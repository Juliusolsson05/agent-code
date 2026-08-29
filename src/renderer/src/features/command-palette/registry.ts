import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { PALETTE_SELF_EXCLUDED_COMMAND_IDS } from '@renderer/features/command-palette/commands/paletteCommands'
import { isVisibleInPicker } from '@renderer/features/command-palette/pickerVisibility'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import type { CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'
import { displayKeybinding } from '@renderer/features/command-keybindings/normalize'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { commandAllowedByRenderedViewPolicy } from '@renderer/workspace/agentDisplayMode'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type {
  CommandContext,
  CommandDef,
  CommandSurface,
  ResolvedCommand,
} from '@renderer/features/command-palette/types'

// The ordered first-party command list now lives in `catalog.ts`, which is
// context-free by contract. This module keeps only the question that NEEDS a
// context: what should the picker show right now. See catalog.ts for why the split
// exists.
//
// Extension commands are deliberately NOT in the catalog — they are derived from
// installed manifests and concatenated per call (see allCommandDefs). A frozen
// module-scope array cannot gain a command when an extension is installed without a
// reload, which is exactly the module-scope-snapshot mistake an adversarial audit
// flagged; the per-call concat is the fix.
const commandDefs: readonly CommandDef[] = builtInCommandCatalog

/**
 * Mode gate applied BEFORE each command's own `when`.
 *
 * This is the one place the surface→mode policy lives. `grid` commands
 * are meaningless or silent no-ops while Dispatch Mode owns the layout
 * (they target `tab.root` grid focus); `dispatch` commands have nothing
 * to act on outside Dispatch. Everything else — `app`, `session`,
 * `editor`, `debug` — is mode-independent and reaches its own `when`.
 *
 * Putting the gate here, not in 13 separate `when` closures, is the
 * point of issue #228: a command's module no longer has to remember to
 * re-implement "...and hide me in the wrong mode." It declares a
 * surface; the registry enforces it uniformly.
 *
 * WHY an exhaustive switch instead of the two ifs plus `return true` this
 * replaces: the fallthrough silently classified any UNKNOWN surface as
 * "available everywhere". That is the permissive direction — a new surface
 * added to the union but forgotten here would not fail the build, it would
 * quietly show its commands in every mode, which is precisely the #228 bug
 * class the surface field was introduced to kill. With `assertNever`, adding
 * a surface without deciding its mode policy is a compile error.
 */
function surfaceAvailable(surface: CommandSurface, ctx: CommandContext): boolean {
  switch (surface) {
    case 'grid':
      return !ctx.flags.dispatchModeEnabled
    case 'dispatch':
      return ctx.flags.dispatchModeEnabled
    case 'app':
    case 'session':
    case 'editor':
    case 'debug':
      // Mode-independent by design. `editor` and `debug` carry their own
      // `when` guards for overlay-open / feature-enabled checks; listing them
      // explicitly rather than defaulting keeps that a stated decision.
      return true
    default:
      return assertNever(surface)
  }
}

/**
 * Exhaustiveness guard. Returns `false` at runtime rather than throwing:
 * a surface this build does not understand should hide the command, not take
 * down the palette. The compile error is the real enforcement; this is the
 * belt-and-braces behavior for a value that reached us across a boundary
 * TypeScript could not check (a persisted blob, a generated command).
 */
function assertNever(value: never): false {
  void value
  return false
}

/**
 * CONTEXTUAL ADMISSION: may this command run right now, given the workspace?
 *
 * This is the predicate every invocation source must agree on — palette,
 * native menu, keybinding, and programmatic dispatch alike. It deliberately
 * combines exactly three things and excludes a fourth:
 *
 *   ✓ surface       — does the concept apply to this layout at all
 *   ✓ when          — is the data it needs actually present
 *   ✓ renderedView  — does the target's view mode support it
 *   ✗ pickerVisibility — PRESENTATION ONLY. Never consulted here.
 *
 * That last exclusion is the whole point of splitting this out. The audit
 * found the native menu resolving ids from the picker-filtered registry, which
 * made a cosmetic "hide from my palette" preference disable a File-menu
 * action. Admission and discoverability are now different functions with
 * different inputs, so it is no longer possible to accidentally spend one as
 * the other.
 *
 * NOTE this is necessary, not sufficient. It answers "is this invocation
 * sensible now", evaluated at dispatch time against fresh state. It does NOT
 * replace the checks a destructive command must make at its own mutation
 * boundary — a target can still disappear between admission and commit. Those
 * per-command revalidations are Phase 2/7 work.
 */
export function commandApplicable(command: CommandDef, ctx: CommandContext): boolean {
  return (
    surfaceAvailable(command.surface, ctx) &&
    (command.when ? command.when(ctx) : true) &&
    renderedViewAvailable(command, ctx)
  )
}

/**
 * Just the mode half of admission, exposed so the availability resolver can
 * tell a MODE MISMATCH apart from a capability refusal.
 *
 * They get different presentations — mode mismatch hides, capability refusal
 * can explain itself — so the two must be distinguishable. Collapsing them
 * into one boolean is what forced every refusal to look identical (and
 * therefore silent) before Phase 2.
 */
export function surfaceApplicable(command: CommandDef, ctx: CommandContext): boolean {
  return surfaceAvailable(command.surface, ctx)
}

/**
 * Picker-visibility gate, applied AFTER admission (so a hidden command that
 * wouldn't apply anyway never reaches this check — order keeps the cheap
 * mode/data filters first and the policy decision last).
 *
 * The resolution rules themselves now live in `pickerVisibility.ts`, shared
 * verbatim with the Settings screen. This wrapper only adapts the live
 * `CommandContext` into that module's context-free policy struct: Settings has
 * no context to offer, and giving it a synthetic one is how presentation logic
 * starts depending on workspace state it should not read.
 */
function commandVisible(command: CommandDef, ctx: CommandContext): boolean {
  return isVisibleInPicker(command, {
    overrides: ctx.flags.commandVisibilityOverrides,
    showHiddenCommands: ctx.flags.showHiddenCommands,
    navigationCommandsEnabled: ctx.flags.navigationCommandsEnabled,
  })
}

function renderedViewAvailable(command: CommandDef, ctx: CommandContext): boolean {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return true
  const kind = ctx.workspace.state.sessions[sessionId]?.kind
  const runtime = ctx.workspace.getRuntime(sessionId)
  return commandAllowedByRenderedViewPolicy({
    policy: command.renderedViewPolicy,
    kind,
    mode: ctx.flags.agentViewMode,
    runtime,
  })
}

/**
 * Every command available right now: the first-party catalog plus whatever the
 * installed extensions declare.
 *
 * Extension commands go LAST so they browse after first-party ones in the
 * empty-query list — registry order is the palette's browse order, and putting
 * third-party entries above the app's own would reshuffle a list people navigate
 * by position.
 */
function allCommandDefs(extensionCommands: readonly CommandDef[]): readonly CommandDef[] {
  return extensionCommands.length === 0
    ? commandDefs
    : [...commandDefs, ...extensionCommands]
}

export function buildCommandRegistry(
  ctx: CommandContext,
  extensionCommands: readonly CommandDef[] = [],
  // Extension keybinding defaults, so an extension command's row shows its shipped
  // chord — the same combined table the router fires from and the editor displays.
  extensionKeybindings: readonly CommandBindingDefault[] = [],
): ResolvedCommand[] {
  // Built once per registry pass rather than per command: resolving the
  // effective set walks every default, so doing it inside the map would be
  // O(commands x defaults) on every palette keystroke.
  const effective = new Map(
    resolveEffectiveKeybindings(ctx.flags.commandKeybindingOverrides, [
      ...buildDefaultKeybindings(),
      ...extensionKeybindings,
    ]).map(entry => [entry.commandId, entry.bindings]),
  )
  return allCommandDefs(extensionCommands)
    .filter(command => !PALETTE_SELF_EXCLUDED_COMMAND_IDS.has(command.id))
    .filter(command => commandApplicable(command, ctx) && commandVisible(command, ctx))
    .map(command => {
      const description = command.description.trim()
      if (!description) {
        throw new Error(`Command ${command.id} is missing a description`)
      }
      return {
        id: command.id,
        title: typeof command.title === 'function' ? command.title(ctx) : command.title,
        description,
        surface: command.surface,
        // Carried through so the palette's `grouped` sort mode can section the
        // list by the taxonomy that was DESIGNED for user-facing grouping.
        // Grouping by `surface` instead is the exact conflation `CommandCategory`
        // was introduced to undo (see its doc comment): `surface` answers "does
        // this concept exist in the current layout", which is a machine
        // applicability question, and reusing it as a presentation axis means a
        // command cannot be reclassified without changing when it applies.
        category: command.category,
        // The FIRST effective binding, in display form. A command may have
        // several (Close Pane has Cmd+W and Alt+W); the row shows one, and the
        // first is the primary by declaration order. Undefined when the command
        // has no chord, which is most of the catalog.
        shortcut: displayBinding(effective.get(command.id)),
        keywords: command.keywords ?? [],
        keepPaletteOpen: command.keepPaletteOpen === true,
        state: command.getState ? command.getState(ctx) : null,
        run: command.run,
      }
    })
}

/** First effective binding as a display chord, or undefined when unbound. */
function displayBinding(bindings: readonly string[] | undefined): string | undefined {
  const first = bindings?.[0]
  return first ? displayKeybinding(first) : undefined
}
