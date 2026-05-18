import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export const readerCommands: CommandDef[] = [
  {
    id: 'toggle-reader-mode',
    title: 'Reader Mode',
    description: '**What it does:** Toggles a cleaner **reading view** for the current agent.\n\n**Use when:** You want to read long agent output comfortably.\n\n**Notes:** Uses the focused command target.',
    keywords: ['reader', 'read', 'focus', 'plan', 'response', 'zen'],
    getState: ({ workspace }) => ({
      label: workspace.readerMode ? 'On' : 'Off',
      tone: workspace.readerMode ? 'accent' : 'neutral',
    }),
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const kind = workspace.state.sessions[sessionId]?.kind ?? 'claude'
      // WHY Reader Mode is agent-only:
      // Reader renders assistant transcript messages. A terminal row renders
      // raw PTY scrollback through xterm.js and has no assistant-message
      // model, so allowing Reader from a terminal would either show an empty
      // surface or pretend terminal output is provider prose.
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace }) => workspace.toggleReaderMode(),
  },
]
