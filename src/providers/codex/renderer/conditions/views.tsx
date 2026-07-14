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
import { defineView, eraseRegistry } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type {
  CodexApprovalState,
  CodexTrustDialogState,
} from '@shared/types/providerConditions'

// CodexStateByKind — the per-provider SOURCE OF TRUTH binding each Codex
// condition kind to its concrete `state` type. The registry literal below is
// checked against this through `eraseRegistry`'s `Partial<ViewRegistry<
// CodexStateByKind>>` parameter, so filing a view under the wrong kind
// (mismatched state shape) is a COMPILE error rather than something the old
// `as unknown as ConditionView` erasure let slip through.
type CodexStateByKind = {
  'codex.approval': CodexApprovalState
  'codex.trust-dialog': CodexTrustDialogState
}

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

// `as const` array → kept for (future) typeof-derived kind unions. Keeping the
// source-of-truth list as a const tuple lets later PRs derive the provider's
// kind union from `typeof CODEX_VIEW_LIST[number]['kind']` without restating it.
export const CODEX_VIEW_LIST = [approvalView, codexTrustView] as const

// Kind → view registry, written as an EXPLICIT object literal (not derived from
// the list via Object.fromEntries) precisely so the per-key kind↔view binding is
// checked. With Object.fromEntries the pairing is computed at runtime and the
// compiler can't verify alignment — which is why the old code had to erase with
// `as unknown as ConditionView` and lost the guarantee entirely.
//
// `eraseRegistry` takes a `Partial<ViewRegistry<CodexStateByKind>>`, so this
// literal is FULLY type-checked against CodexStateByKind by the function's
// parameter: a wrong mapping (e.g. `'codex.trust-dialog': approvalView`) is a
// compile error at THIS call. The helper then performs the single, documented
// precise→erased cast the outlet needs (see eraseRegistry's WHY in view.ts —
// the outlet routes by `kind` and only ever feeds a Component its own kind's
// state, so erasing S for routing is sound). One checked erasure replaces N
// unchecked per-view casts.
export const CODEX_VIEWS: Record<string, ConditionView> = eraseRegistry<CodexStateByKind>({
  'codex.approval': approvalView,
  'codex.trust-dialog': codexTrustView,
})
