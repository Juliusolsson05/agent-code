import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// "Set color flag" — mark the currently-commanded agent with a colored strip on
// the right edge of its Dispatch row, so it's easy to spot while scanning many
// running workflows. See docs/plans_and_ideas/2026-07-23-dispatch-color-flags.md.
//
// `surface: 'session'` (not 'dispatch') so a flag can be set from any mode; the
// strip is a Dispatch-list affordance, but the act of flagging an agent isn't
// mode-specific and shouldn't disappear the moment you leave Dispatch. Targets
// `commandTargetSessionId` (Dispatch-aware focus), so it needs no separate row
// selection. No keybind by design — a low-frequency, list-management action.
//
// No getState chip: the current flag is already visible on the row itself, and
// the command context does not carry the settings store, so surfacing it here
// would mean threading settings into every command's context for one label.
export const dispatchColorFlagCommands: CommandDef[] = [
  {
    id: 'dispatch.color-flag.set',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Set Color Flag…',
    description:
      '**What it does:** Marks the focused agent with a colored strip on the ' +
      'right edge of its **Dispatch row**, so you can spot it in a long list.\n\n' +
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
