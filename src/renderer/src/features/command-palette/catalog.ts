import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import { globalEditorCommands } from '@renderer/features/global-editor/commands/globalEditorCommands'
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
import { replyToSelectionCommands } from '@renderer/features/reply-to-selection/commands/replyToSelectionCommands'
import { agentStatusCommands } from '@renderer/features/agent-status/commands/agentStatusCommands'
import { dispatchColorFlagCommands } from '@renderer/features/workspace/commands/dispatchColorFlagCommands'
import { remoteCommands } from '@renderer/features/remote/commands/remoteCommands'
import { usageCommands } from '@renderer/features/usage/commands/usageCommands'
import type { CommandDef } from '@renderer/features/command-palette/types'

/**
 * The context-free catalog: every built-in command Agent Code ships, in
 * registration order, with NO contextual filtering applied.
 *
 * WHY this is a module of its own rather than the array that used to live at
 * the top of `registry.ts`:
 *
 * `registry.ts` answers "what should the picker show right now", which requires
 * a live `CommandContext` (a focused session, the ui callback bag, the flags
 * snapshot). Four other consumers need a different question answered — "what
 * commands EXIST" — and none of them has a context to offer:
 *
 *   - the native menu, which dispatches stable ids from the main process;
 *   - Settings, which lists every command the user may show/hide or bind;
 *   - catalog validation, which must see hidden and inapplicable commands too;
 *   - diagnostics, which resolve an id long after the invocation that used it.
 *
 * Those consumers previously reached through `buildCommandRegistry`, which
 * meant they inherited picker filtering as a side effect. That is precisely the
 * defect the governance plan calls "a picker resolver, not a command-admission
 * authority": a cosmetic `commandVisibilityOverrides[id] = false` could remove
 * a native File-menu action, because the menu resolved ids from an
 * already-filtered list. Splitting the catalog out is the structural
 * precondition for fixing that — presentation can filter a catalog, but a
 * catalog must never be defined by what presentation happened to keep.
 *
 * INVARIANT: this array is context-free and side-effect-free at module scope.
 * Nothing here may read the workspace store, the settings store, or the DOM.
 * The generated per-provider entries below are the one computed part, and they
 * derive only from the static provider registry.
 *
 * INVARIANT: registration order is user-visible — it is the palette's
 * empty-query browse order, and people navigate that list by position. Reorder
 * only deliberately; `catalog.test.ts` pins the exact order so an accidental
 * import shuffle fails loudly instead of silently reshuffling the UI.
 */
export const builtInCommandCatalog: readonly CommandDef[] = Object.freeze([
  ...tabCommands,
  ...paneCommands,
  ...layoutCommands,
  // Registered right after layoutCommands so the moved editor commands
  // keep (approximately) their old registry order — registry order is the
  // palette's empty-query browse order, and gratuitous reshuffles read as
  // regressions to users who navigate by position.
  ...globalEditorCommands,
  ...sessionCommands,
  ...dispatchColorFlagCommands,
  ...spotlightCommands,
  ...readerCommands,
  ...tileTabsCommands,
  ...settingsCommands,
  ...copyAssistantCommands,
  ...copyCodeBlockCommands,
  ...promptTemplateCommands,
  // Grouped with the prompt-template commands because it is the other
  // composer-insertion command — registry order is the palette's
  // empty-query browse order, so like things stay adjacent.
  ...replyToSelectionCommands,
  ...agentStatusCommands,
  ...remoteCommands,
  ...usageCommands,
])

/**
 * Structural problems found in a catalog, as human-readable sentences.
 *
 * WHY this returns a list instead of throwing on the first problem: the caller
 * is either a test (which should report every defect in one run, not make the
 * author replay the suite once per typo) or a future dev-mode boot check. Both
 * want the complete picture. It is also deliberately a pure function over an
 * arbitrary array rather than a check of the module-level catalog, so a test
 * can feed it a deliberately broken fixture and assert the diagnosis.
 *
 * WHY validation lives here rather than inside `buildCommandRegistry`'s map:
 * the registry only ever sees commands that survived contextual filtering, so
 * a missing description on a Dispatch-only command went unnoticed in Grid and
 * threw at the moment a user switched modes. Validating the context-free
 * catalog moves that failure to a test, before it can reach anyone.
 */
export function findCatalogDefects(commands: readonly CommandDef[]): string[] {
  const defects: string[] = []
  const seen = new Map<string, number>()

  commands.forEach((command, index) => {
    const previous = seen.get(command.id)
    if (previous !== undefined) {
      defects.push(
        `duplicate id "${command.id}" at index ${index} (first seen at ${previous})`,
      )
    } else {
      seen.set(command.id, index)
    }

    if (!command.id.trim()) defects.push(`command at index ${index} has an empty id`)
    if (!command.description.trim()) defects.push(`command "${command.id}" has an empty description`)
    if (typeof command.run !== 'function') defects.push(`command "${command.id}" has no run handler`)

    // A function title is legitimate (state-dependent labels flip their text),
    // but an empty STATIC title would render a blank palette row and a blank
    // Settings row with no way to tell which command it is.
    if (typeof command.title === 'string' && !command.title.trim()) {
      defects.push(`command "${command.id}" has an empty title`)
    }

    if (!VALID_SURFACES.has(command.surface)) {
      defects.push(`command "${command.id}" has unknown surface "${command.surface}"`)
    }

    const tier = command.pickerVisibility ?? 'default'
    if (!VALID_TIERS.has(tier)) {
      defects.push(`command "${command.id}" has unknown pickerVisibility "${tier}"`)
    }
  })

  return defects
}

// Kept as runtime sets rather than relying on the compile-time union alone:
// the catalog is the boundary a future extension-contributed or
// provider-generated command crosses, and those are built from strings that
// TypeScript cannot check at the point of construction.
const VALID_SURFACES = new Set(['app', 'grid', 'dispatch', 'session', 'editor', 'debug'])
const VALID_TIERS = new Set(['default', 'advanced', 'experimental', 'debug'])
