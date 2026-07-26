import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// "Set Color Flag…" — mark the currently-commanded agent with a color, so it's
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
// The command id and the settings key both still say "dispatch" even though
// the flag now renders in the pane header too. Neither is a description — both
// are persisted identifiers: the id keys `Settings.commandVisibilityOverrides`,
// so renaming it silently drops a user's saved show/hide choices, and the key
// holds the flags themselves, so renaming it costs a PERSIST_VERSION migration.
// The name is historical — the feature was born in Dispatch. Treat "dispatch
// color flag" as the concept's proper noun, not as a claim about where it
// renders. (The exported symbol below shares the prefix for consistency only;
// it is not persisted and can be renamed freely.)
//
// No getState chip: the current flag is already visible on the row and in the
// pane header, and the command context does not carry the settings store, so
// surfacing it here would mean threading settings into every command's context
// for one label.
export const dispatchColorFlagCommands: CommandDef[] = [
  {
    id: 'dispatch.color-flag.set',
    // `session`, NOT `layout-dispatch`, and `default`, NOT `advanced`.
    //
    // Both were set on this branch while the flag was a Dispatch-list
    // affordance, and #609 (session header color flags) invalidated both: the
    // flag now renders as a chunk of the pane's session header, so it is
    // visible — and worth changing — to a user who never opens Dispatch.
    //
    // Filing it under Layout & Dispatch would put it in the one category a
    // grid-only user has no reason to browse, and `advanced` would keep it out
    // of their palette entirely. Someone who just noticed a coloured header and
    // wants to change it would find nothing. The category matches what the
    // command ACTS on (a session), which is also what `surface: 'session'`
    // already says.
    //
    // The `dispatch.` id prefix stays for the persistence reason above; it is
    // not evidence about where this belongs in the picker.
    category: 'session',
    surface: 'session',
    // Title case + ellipsis per docs/command-style.md rules 8 and 9: `run`
    // always opens the swatch picker, so the command needs more input after
    // invocation and must advertise that.
    title: 'Set Color Flag…',
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
