import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { enumerateCodeBlockIds } from '@renderer/features/copy-code-block/lib/enumerateCodeBlocks'

function afterRenderedPaneCommit(callback: () => void): void {
  // WHY two animation frames instead of immediate enumeration:
  // in Hybrid mode, invoking this command can be the event that acquires the
  // render lease. React still has to swap AgentTerminalLeaf for TileLeaf before
  // `[data-code-block-id]` nodes exist. One frame schedules after the command's
  // state update has been observed; the second gives the browser a committed
  // DOM tree to query. This is intentionally local to the DOM-backed picker:
  // transcript-backed commands do not need a render-turn handshake.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(callback)
  })
}

// "Copy Code Block…" — the code-block analogue of "Copy Assistant
// Message…" (features/copy-assistant). It opens a picker on the
// focused pane; Up/Down move between the code blocks in that pane's
// feed, Enter copies the selected block, Esc cancels. All of that
// navigation lives in useKeybinds — the command itself only TOGGLES
// the picker on/off, exactly like copy-assistant's `pickerEnter`.
//
// WHY enumeration happens here in `run` and not in a workspace
// action: code blocks have no transcript identity, so the ordered
// list only exists in the DOM (see enumerateCodeBlockIds). The
// command resolves "which block is selected first" by reading the
// DOM at invoke time and seeding the picker with the LAST (most
// recent) block — mirroring copy-assistant, which seeds on the most
// recent assistant message.
export const copyCodeBlockCommands: CommandDef[] = [
  {
    id: 'copy-code-block',
    surface: 'session',
    title: 'Copy Code Block…',
    description: '**What it does:** Opens a picker to copy a specific **code block** from the focused pane.\n\n**Use when:** You want one fenced block — a command, a snippet, a generated file — without copying the whole message.\n\n**Notes:** Use arrows to move between blocks, **Enter** to copy, **Esc** to cancel. Starts on the most recent block.',
    renderedViewPolicy: {
      kind: 'leases-rendered-feed',
      feature: 'copy-code-block',
    },
    keywords: ['copy', 'code', 'block', 'snippet', 'fenced', 'pick'],
    when: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return false
      const kind = workspace.state.sessions[sessionId]?.kind ?? 'claude'
      // WHY terminal rows are excluded:
      // code-block picking walks rendered feed DOM nodes with
      // data-code-block-id. Terminal output is painted by xterm, not the feed
      // renderer, so there is no stable code-block identity to enumerate or
      // highlight.
      return kind === 'claude' || kind === 'codex'
    },
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return

      // Toggle: a second invocation while the picker is open closes
      // it, same contract as copy-assistant's pickerEnter.
      if (workspace.runtimes[sessionId]?.codeBlockPicker) {
        workspace.setCodeBlockPicker(sessionId, null)
        return
      }

      workspace.acquireRenderedViewLease(sessionId, 'copy-code-block')
      afterRenderedPaneCommit(() => {
        const ids = enumerateCodeBlockIds(sessionId)
        if (ids.length === 0) {
          workspace.releaseRenderedViewLease(sessionId, 'copy-code-block')
          workspace.showPaneToast(sessionId, 'No code blocks in this pane')
          return
        }
        // Seed on the most recent (last in document order). setCodeBlockPicker
        // takes ownership of the ongoing picker lease; release this short
        // command-start lease after the picker is parked so Hybrid stays
        // rendered for navigation but does not retain two counts.
        workspace.setCodeBlockPicker(sessionId, { selectedId: ids[ids.length - 1] })
        workspace.releaseRenderedViewLease(sessionId, 'copy-code-block')
      })
    },
  },
]
