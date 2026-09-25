// Grok condition VIEW modules — the OpenCode views are the template.
//
// Like structured OpenCode, every choice is a `custom` action the runtime
// built: the headless's condition modules attach one action per option native
// offered (in native's order), a permission cancel, a question cancel, and the
// two plan outcomes. Dispatch routes them through session:resolveCondition →
// GrokSession.resolveCondition → GrokHeadless.resolveConditionAction, which
// refuses a token native already resolved before writing anything.
//
// WHY the Component renders buttons straight off `actions` instead of
// hardcoding Allow/Reject: native's option list IS the protocol (allow-once,
// always-allow, allow-edits-session, reject-once, ... vary by tool; the
// subagent request offered allow-edits-session instead of always-allow), so the
// runtime is the single source of truth and the view stays dumb.
//
// The plan view renders the plan content the way OpenCode renders question
// text (a code slab): it is a document the user must read before approving.

import { defineView, eraseRegistry } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ConditionAction } from '@shared/conditions-core/contract'
import type {
  GrokPermissionConditionState,
  GrokPlanApprovalConditionState,
  GrokQuestionConditionState,
} from '@shared/types/providerConditions'
import { withVisibleControls } from '@shared/text/visibleControls'
import { ConditionPromptShell } from '@providers/shared/renderer/conditions/ConditionPromptShell'

// Per-provider kind→state binding: eraseRegistry checks the registry literal
// against this, so filing a view under the wrong kind is a compile error.
type GrokStateByKind = {
  'grok.permission': GrokPermissionConditionState
  'grok.question': GrokQuestionConditionState
  'grok.plan-approval': GrokPlanApprovalConditionState
}

// Cancel/reject/abandon read as the destructive choice — style them muted;
// everything else (allow options, approve) is a primary accent button. The
// permission option actions share one action name, so the runtime-authored
// label is the reliable discriminator, exactly as in the OpenCode views.
function isRejectAction(action: ConditionAction): boolean {
  return /cancel|reject|deny|decline|abandon/i.test(action.label)
}

// The shell is shared with the other runtime-authored provider (UI pass):
// providers/shared/renderer/conditions/ConditionPromptShell.tsx.
function ConditionShell({
  heading,
  children,
  actions,
  dispatch,
}: {
  heading: string
  children: React.ReactNode
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
}) {
  return (
    <ConditionPromptShell
      heading={heading}
      description="Grok is waiting for an explicit response before it can continue."
      actions={actions}
      dispatch={dispatch}
      isReject={isRejectAction}
    >
      {children}
    </ConditionPromptShell>
  )
}

export const grokPermissionView = defineView<
  'grok.permission',
  GrokPermissionConditionState
>({
  kind: 'grok.permission',
  layout: 'modal',
  // A tool-permission request demands a decision → ACTION.
  attention: state => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    return (
      <ConditionShell
        heading="Grok needs permission"
        actions={actions}
        dispatch={dispatch}
      >
        <p className="mb-2">
          Grok is requesting permission
          {state.title ? (
            <>
              {' '}for <span className="text-accent">{withVisibleControls(state.title)}</span>
            </>
          ) : null}
          .
        </p>
      </ConditionShell>
    )
  },
})

export const grokQuestionView = defineView<
  'grok.question',
  GrokQuestionConditionState
>({
  kind: 'grok.question',
  layout: 'modal',
  attention: state => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    return (
      <ConditionShell heading="Grok is asking" actions={actions} dispatch={dispatch}>
        {state.text ? (
          <pre className="bg-code-bg rounded-slab text-code-ink px-3 py-2 mb-1 overflow-x-auto whitespace-pre-wrap text-[11.5px]">
            {withVisibleControls(state.text)}
          </pre>
        ) : (
          <p className="mb-2">Grok is waiting for a response.</p>
        )}
        {/* Cancel-only by design: native renders the option list in its own
            terminal where the user answers; cancelling from outside is the one
            always-safe action (see conditions/modules.ts in the package). */}
      </ConditionShell>
    )
  },
})

export const grokPlanApprovalView = defineView<
  'grok.plan-approval',
  GrokPlanApprovalConditionState
>({
  kind: 'grok.plan-approval',
  layout: 'modal',
  attention: state => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    return (
      <ConditionShell heading="Grok proposes a plan" actions={actions} dispatch={dispatch}>
        {state.planContent ? (
          <pre className="bg-code-bg rounded-slab text-code-ink px-3 py-2 mb-1 overflow-x-auto whitespace-pre-wrap text-[11.5px]">
            {/* The plan is the thing being approved; a reordering override in
                it misrepresents what the user is authorising (#1049
                re-review). */}
            {withVisibleControls(state.planContent)}
          </pre>
        ) : (
          <p className="mb-2">Grok is waiting for plan approval.</p>
        )}
      </ConditionShell>
    )
  },
})

// Explicit object literal (not Object.fromEntries) so the per-key kind↔view
// binding is compiler-checked against GrokStateByKind via eraseRegistry — see
// the OpenCode and Codex registries.
export const GROK_VIEWS: Record<string, ConditionView> =
  eraseRegistry<GrokStateByKind>({
    'grok.permission': grokPermissionView,
    'grok.question': grokQuestionView,
    'grok.plan-approval': grokPlanApprovalView,
  })
