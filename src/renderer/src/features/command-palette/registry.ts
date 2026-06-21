import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'
import { tabCommands } from '@renderer/features/workspace/commands/tabCommands'
import { settingsCommands } from '@renderer/features/settings/commands/settingsCommands'
import { spotlightCommands } from '@renderer/features/spotlight/commands/spotlightCommands'
import { tileTabsCommands } from '@renderer/features/tile-tabs/commands/tileTabsCommands'
import { readerCommands } from '@renderer/features/reader/commands/readerCommands'
import { copyAssistantCommands } from '@renderer/features/copy-assistant/commands/copyAssistantCommands'
import { copyCodeBlockCommands } from '@renderer/features/copy-code-block/commands/copyCodeBlockCommands'
import { promptTemplateCommands } from '@renderer/features/prompt-templates/commands/promptTemplateCommands'
import { agentStatusCommands } from '@renderer/features/agent-status/commands/agentStatusCommands'
import type {
  CommandContext,
  CommandDef,
  CommandPickerVisibility,
  CommandSurface,
  ResolvedCommand,
} from '@renderer/features/command-palette/types'

const commandDefs: CommandDef[] = [
  ...tabCommands,
  ...paneCommands,
  ...layoutCommands,
  ...sessionCommands,
  ...spotlightCommands,
  ...readerCommands,
  ...tileTabsCommands,
  ...settingsCommands,
  ...copyAssistantCommands,
  ...copyCodeBlockCommands,
  ...promptTemplateCommands,
  ...agentStatusCommands,
]

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
 */
function surfaceAvailable(surface: CommandSurface, ctx: CommandContext): boolean {
  if (surface === 'grid') return !ctx.flags.dispatchModeEnabled
  if (surface === 'dispatch') return ctx.flags.dispatchModeEnabled
  return true
}

/**
 * Picker-visibility gate, applied AFTER `surfaceAvailable` and the
 * command's own `when` (so a hidden command that wouldn't apply anyway
 * never reaches this check — order keeps the cheap mode/data filters
 * first and the policy decision last).
 *
 * CRUCIAL: this gate affects ONLY whether a command appears in the
 * command-picker list. It does NOT touch `command.run()` and is NOT
 * consulted by any keybinding or programmatic invocation path. A
 * command hidden here is still fully executable by its shortcut — issue
 * #249 is about list noise, not capability. Wiring keybindings to this
 * function would be a regression, not a feature.
 *
 * Effective visibility resolution (most specific wins):
 *   1. `showHiddenCommands` → everything visible (global escape hatch).
 *   2. an explicit per-command override (`true`/`false`) → that value.
 *   3. otherwise the command's declared `pickerVisibility`, where the
 *      field's absence means `'default'`. Only `'default'` is shown;
 *      every other tier (`advanced`/`experimental`/`debug`) is hidden
 *      unless an override or the escape hatch says otherwise.
 */
function commandVisible(command: CommandDef, ctx: CommandContext): boolean {
  if (ctx.flags.showHiddenCommands) return true

  // Optional-chain defensively: this gate runs inside the first render's
  // useMemo, so if `commandVisibilityOverrides` is ever undefined (e.g. a
  // persisted-settings shape that predates the field and slipped past
  // coercion), a bare `[id]` index throws and takes the WHOLE app to a black
  // screen — exactly the #249 launch regression. A missing override map must
  // degrade to "no per-command override", never crash the registry build.
  const override = ctx.flags.commandVisibilityOverrides?.[command.id]
  if (typeof override === 'boolean') return override

  return (command.pickerVisibility ?? 'default') === 'default'
}

export function buildCommandRegistry(ctx: CommandContext): ResolvedCommand[] {
  return commandDefs
    .filter(
      command =>
        surfaceAvailable(command.surface, ctx) &&
        (command.when ? command.when(ctx) : true) &&
        commandVisible(command, ctx),
    )
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
        shortcut: command.shortcut,
        keywords: command.keywords ?? [],
        keepPaletteOpen: command.keepPaletteOpen === true,
        state: command.getState ? command.getState(ctx) : null,
        run: command.run,
      }
    })
}

/** Static metadata for one command, surfaced to the settings UI so a
 *  user can flip its picker visibility without the settings layer
 *  needing a live CommandContext. */
export type PickerCommandMeta = {
  id: string
  title: string
  pickerVisibility: CommandPickerVisibility
}

/**
 * Flat, context-free list of every command's identity + declared
 * picker visibility, for the "Commands" settings category.
 *
 * WHY context-free: the settings screen has no CommandContext (no
 * focused session, no live ui callbacks) and shouldn't synthesize a
 * fake one just to read titles. So this deliberately skips per-command
 * `when`/`surface` gating — the settings list is the FULL catalog of
 * commands a user might want to show/hide, not the subset currently
 * applicable. A command being mode-gated out right now doesn't change
 * whether the user wants it in the picker when it IS applicable.
 *
 * Function-typed titles (`title: (ctx) => string`) can't be resolved
 * without a context, so we fall back to the stable `id` as the label.
 * Those are the toggle-style commands whose text flips with state; the
 * id is a stable, recognizable stand-in for a settings row and avoids
 * inventing a dummy context purely for a display string.
 */
export function listPickerCommandMeta(): PickerCommandMeta[] {
  return commandDefs.map(command => ({
    id: command.id,
    title: typeof command.title === 'function' ? command.id : command.title,
    pickerVisibility: command.pickerVisibility ?? 'default',
  }))
}
