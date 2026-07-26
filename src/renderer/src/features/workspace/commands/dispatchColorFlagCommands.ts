import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// "Set color flag" — mark the currently-commanded agent with a color, so it's
// easy to spot while scanning many running workflows. It renders as a strip on
// the right edge of the agent's Dispatch row and as a chunk of its pane's
// session header. See docs/plans_and_ideas/2026-07-23-dispatch-color-flags.md
// and docs/superpowers/plans/2026-07-26-session-header-color-flag.md.
//
// `surface: 'session'` (not 'dispatch') so a flag can be set from any mode.
// That choice predates the header surface and was already right for a different
// reason — flagging an agent isn't mode-specific and shouldn't disappear the
// moment you leave Dispatch — but the header makes it load-bearing: the flag is
// now visible in the grid, so a grid-only user must be able to set one. Targets
// `commandTargetSessionId` (Dispatch-aware focus), so it needs no separate row
// selection. No keybind by design — a low-frequency, list-management action.
//
// The export, the command id, and the settings key all still say "dispatch"
// even though the flag now renders in the pane header too. Both names are
// persisted identifiers, not descriptions: the command id keys
// `Settings.commandVisibilityOverrides` and the settings key holds the flags
// themselves, so renaming either costs a migration and can silently drop a
// user's saved command-visibility choices. The name is historical — the feature
// was born in Dispatch. Treat "dispatch color flag" as the concept's proper
// noun, not as a claim about where it renders.
//
// No getState chip: the current flag is already visible on the row and in the
// pane header, and
// the command context does not carry the settings store, so surfacing it here
// would mean threading settings into every command's context for one label.
export const dispatchColorFlagCommands: CommandDef[] = [
  {
    id: 'dispatch.color-flag.set',
    surface: 'session',
    title: 'Set color flag',
    description:
      '**What it does:** Marks the focused agent with a color — a chunk of its ' +
      '**session header** in the grid, and a strip on the right edge of its ' +
      '**Dispatch row**.\n\n' +
      '**Use when:** You are juggling several agents and want to flag one ' +
      '(e.g. red) to find it fast.',
    keywords: ['color', 'colour', 'flag', 'highlight', 'mark', 'tag', 'dispatch', 'spot'],
    when: ({ workspace }) => commandTargetSessionId(workspace) !== null,
    run: ({ workspace, ui }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (sessionId) ui.openColorFlagPicker(sessionId)
    },
  },
]
