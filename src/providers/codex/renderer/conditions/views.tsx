// Codex condition VIEW modules.
//
// Each view is a thin adapter that wraps an EXISTING modal component and
// registers it under its condition kind. We do NOT rewrite the modals — they
// keep their exact prop shape, keystrokes, and behavior. The only thing the
// adapter changes is the plumbing: the modal's `onSend(data)` callback now
// flows through `dispatch({ kind: 'pty', … })` → the dispatch pty arm →
// sendInput, which is byte-for-byte the same send path the old
// CodexConditionOutlet used.
//
// WHY adapters instead of teaching the modals the dispatch shape directly:
// the modals are shared, dumb presentation components keyed on `onSend`. The
// registry framework only needs a `dispatch`-shaped contract at the VIEW
// boundary. Adapting at the boundary keeps the modals untouched (zero blast
// radius) and keeps the state→props mapping that used to live in the old
// outlet exactly where you'd look for it.

import { CodexApprovalModal } from '@providers/codex/renderer/CodexApprovalModal'
import { CodexTrustDialogModal } from '@providers/codex/renderer/conditions/CodexTrustDialogModal'
import { defineView } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type {
  CodexApprovalState,
  CodexTrustDialogState,
} from '@shared/types/providerConditions'

// A `pty` action whose only meaningful field is `data`. The id/label are
// cosmetic here because the modal already owns its own button labels and only
// hands us raw keystroke strings via onSend. We synthesize the action shape so
// the dispatch contract is satisfied; dispatch reads only `.data`.
const raw = (data: string) => ({ kind: 'pty' as const, id: 'raw', label: '', data })

// codex.approval — wraps the inline approval strip. The state→props mapping is
// lifted verbatim from the old CodexConditionOutlet, INCLUDING the
// `commandParts ?? command.split(/\s+/)` fallback (some snapshots carry a
// pre-split commandParts array; older ones carry a single command string we
// must split ourselves to feed the modal's `command: string[]` prop).
export const approvalView = defineView<'codex.approval', CodexApprovalState>({
  kind: 'codex.approval',
  layout: 'strip',
  // Approval is an action-demanding prompt → ACTION, matching selectors.ts
  // (codex.approval → 'ACTION').
  attention: () => 'ACTION',
  Component: ({ state, dispatch }) => (
    <CodexApprovalModal
      approval={
        state
          ? {
              callId: state.callId ?? null,
              command:
                state.commandParts ??
                (state.command ? state.command.split(/\s+/) : []),
              workdir: state.workdir ?? null,
              reason: state.reason,
              options: state.options,
              selectedIndex: state.selectedIndex,
            }
          : null
      }
      onSend={(data) => dispatch(raw(data))}
    />
  ),
})

// codex.trust-dialog — wraps the modal trust dialog. Only renders when
// `state.visible`, mirroring the old outlet's `trust?.visible ? … : null`.
export const codexTrustView = defineView<'codex.trust-dialog', CodexTrustDialogState>({
  kind: 'codex.trust-dialog',
  layout: 'modal',
  // Trust → TRUST, matching selectors.ts (codex.trust-dialog → 'TRUST').
  attention: () => 'TRUST',
  Component: ({ state, dispatch }) => (
    <CodexTrustDialogModal
      state={state?.visible ? { workspace: state.workspace } : null}
      onSend={(data) => dispatch(raw(data))}
    />
  ),
})

// `as const` array → the registry below + (future) typeof-derived unions.
// Keeping the source-of-truth list as a const tuple lets later PRs derive the
// provider's kind union from `typeof CODEX_VIEW_LIST` without restating it.
export const CODEX_VIEW_LIST = [approvalView, codexTrustView] as const

// Kind → erased view registry consumed by the generic ConditionOutlet. The
// core routes by kind and never reads state, so erasing to ConditionView here
// is sound (see ConditionOutlet WHY).
export const CODEX_VIEWS: Record<string, ConditionView> = Object.fromEntries(
  CODEX_VIEW_LIST.map((v) => [v.kind, v as unknown as ConditionView]),
)
