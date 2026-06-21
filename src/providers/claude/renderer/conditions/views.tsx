// Claude condition VIEW modules.
//
// Thin adapters wrapping the EXISTING Claude modals (TrustDialogModal,
// PermissionPromptModal, ResumePromptModal) and the read-only CompactionStrip.
// Same principle as the Codex views: do not rewrite the modals; translate their
// `onSend(data)` callback into `dispatch({ kind: 'pty', … })` so keystrokes
// flow through the dispatch pty arm → sendInput, identical to the old
// ClaudeConditionOutlet.
//
// NOTE ON LIVENESS: Claude's headless emitter does not yet emit a `conditions`
// snapshot (that lands in a later PR). So these views are REGISTERED and READY
// but currently DORMANT — nothing flips them on until the Claude emitter ships.
// Wiring them now (a) proves the registry is provider-symmetric and (b) means
// the emitter PR is "turn on the wire", not "also build the renderer".

import { CompactionStrip } from '@renderer/workspace/tile-tree/TileLeaf/CompactionStrip'
import { PermissionPromptModal } from '@providers/claude/renderer/PermissionPromptModal'
import { ResumePromptModal } from '@providers/claude/renderer/ResumePromptModal'
import { TrustDialogModal } from '@providers/claude/renderer/TrustDialogModal'
import { defineView } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type {
  ClaudeTrustDialogState,
  ClaudePermissionPromptState,
  ClaudeResumePromptState,
  ClaudeCompactionState,
} from '@shared/types/providerConditions'

const raw = (data: string) => ({ kind: 'pty' as const, id: 'raw', label: '', data })

// claude.trust-dialog — only renders when visible, mirroring the old outlet's
// `trust?.visible ? { workspace } : null`.
export const claudeTrustView = defineView<'claude.trust-dialog', ClaudeTrustDialogState>({
  kind: 'claude.trust-dialog',
  layout: 'modal',
  // selectors.ts: claude.trust-dialog → 'TRUST'.
  attention: () => 'TRUST',
  Component: ({ state, dispatch }) => (
    <TrustDialogModal
      state={state?.visible ? { workspace: state.workspace } : null}
      onSend={(data) => dispatch(raw(data))}
    />
  ),
})

// claude.permission-prompt — state→props mapping lifted verbatim from the old
// outlet (title/toolName/command/options/selectedIndex), gated on visible.
export const permissionView = defineView<'claude.permission-prompt', ClaudePermissionPromptState>({
  kind: 'claude.permission-prompt',
  layout: 'modal',
  // selectors.ts: claude.permission-prompt → 'ACTION'.
  attention: () => 'ACTION',
  Component: ({ state, dispatch }) => (
    <PermissionPromptModal
      state={
        state?.visible
          ? {
              title: state.title,
              toolName: state.toolName,
              command: state.command,
              options: state.options,
              selectedIndex: state.selectedIndex,
            }
          : null
      }
      onSend={(data) => dispatch(raw(data))}
    />
  ),
})

// claude.resume-prompt — the old outlet maps to the modal's `prompt` prop with
// {sessionAgeText, tokenCountText, selectedIndex}, gated on visible.
export const resumeView = defineView<'claude.resume-prompt', ClaudeResumePromptState>({
  kind: 'claude.resume-prompt',
  layout: 'strip',
  // selectors.ts: claude.resume-prompt → 'RESUME'.
  attention: () => 'RESUME',
  Component: ({ state, dispatch }) => (
    <ResumePromptModal
      prompt={
        state?.visible
          ? {
              sessionAgeText: state.sessionAgeText,
              tokenCountText: state.tokenCountText,
              selectedIndex: state.selectedIndex,
            }
          : null
      }
      onSend={(data) => dispatch(raw(data))}
    />
  ),
})

// claude.compaction — READ-ONLY strip; it never dispatches (CompactionStrip has
// no onSend). The old outlet gated on `compaction?.visible && compaction.phase`
// before passing {phase, statusText, errorText}; we preserve that exact guard.
// attention is 'ERROR' only when phase === 'error', matching selectors.ts
// (claude.compaction with phase 'error' → 'ERROR', otherwise no attention).
export const compactionView = defineView<'claude.compaction', ClaudeCompactionState>({
  kind: 'claude.compaction',
  layout: 'strip',
  attention: (state) => (state?.phase === 'error' ? 'ERROR' : null),
  Component: ({ state }) => (
    <CompactionStrip
      pendingCompaction={
        state?.visible && state.phase
          ? {
              phase: state.phase,
              statusText: state.statusText,
              errorText: state.errorText,
            }
          : null
      }
    />
  ),
})

// `as const` source-of-truth list (see Codex views WHY).
export const CLAUDE_VIEW_LIST = [
  claudeTrustView,
  permissionView,
  resumeView,
  compactionView,
] as const

export const CLAUDE_VIEWS: Record<string, ConditionView> = Object.fromEntries(
  CLAUDE_VIEW_LIST.map((v) => [v.kind, v as unknown as ConditionView]),
)
