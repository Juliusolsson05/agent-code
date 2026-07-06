// OpenCode condition VIEW modules (#406 step 6).
//
// Unlike the Claude/Codex views — thin adapters over existing modal
// components whose buttons emit raw PTY keystrokes via
// dispatch({kind:'pty', ...}) — opencode has no terminal. Every choice
// is a `custom` action the runtime built (OpencodeSession folds the
// screen permission/question events into the snapshot AND attaches the
// action list), and dispatch routes it through
// session:resolveCondition → OpencodeSession.resolveCondition →
// PermissionService.reply / rejectQuestion over HTTP.
//
// WHY the Component renders buttons straight off `actions` instead of
// hardcoding Allow/Reject: the runtime is the single source of truth for
// which choices exist and what they mean (once/always/reject, or a
// reject-only question). Rendering the runtime's action list keeps the
// view dumb and means a future richer question answerer only touches the
// runtime — the view already renders whatever actions arrive.

import { defineView, eraseRegistry } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ConditionAction } from '@shared/conditions-core/contract'
import type {
  OpencodePermissionState,
  OpencodeQuestionState,
} from '@shared/types/providerConditions'

// Per-provider kind→state binding (see CodexStateByKind for the rationale
// — eraseRegistry checks the registry literal against this, so filing a
// view under the wrong kind is a compile error).
type OpencodeStateByKind = {
  'opencode.permission': OpencodePermissionState
  'opencode.question': OpencodeQuestionState
}

// Reject/deny actions read as the destructive choice — style them muted;
// everything else (allow once/always, an answer) is a primary accent
// button. Detection is by the runtime-authored label (permission-reject
// shares the same action name as allow, so the label is the reliable
// discriminator).
function isRejectAction(action: ConditionAction): boolean {
  return /reject|deny|decline/i.test(action.label)
}

function ConditionButtons({
  actions,
  dispatch,
}: {
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
}) {
  // autoFocus the first non-destructive action so Enter accepts, not
  // rejects — matches the trust-dialog convention.
  const firstPrimaryIdx = actions.findIndex(a => !isRejectAction(a))
  return (
    <div className="flex justify-end gap-2 mt-6">
      {actions.map((action, i) => {
        const reject = isRejectAction(action)
        return (
          <button
            key={action.kind === 'custom' ? action.id : `pty-${i}`}
            type="button"
            autoFocus={i === firstPrimaryIdx}
            onClick={() => {
              void dispatch(action)
            }}
            className={
              reject
                ? 'px-4 py-1.5 text-[12px] bg-transparent text-ink-dim border border-border hover:border-border-hi hover:text-ink transition-colors duration-120'
                : 'px-4 py-1.5 text-[12px] font-semibold bg-accent text-accent-fg border border-accent hover:brightness-110 transition-all duration-120'
            }
          >
            {action.label}
          </button>
        )
      })}
    </div>
  )
}

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
    <div
      role="dialog"
      aria-modal="true"
      className="modal-fade fixed inset-0 z-[1000] flex items-center justify-center bg-canvas/80 backdrop-blur-sm"
    >
      <div className="modal-pop w-[480px] max-w-[calc(100vw-64px)] bg-surface border border-border-hi p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="text-accent text-[18px] leading-none select-none pt-0.5">!</div>
          <div className="text-[14px] font-semibold text-ink leading-[1.3]">{heading}</div>
        </div>
        <div className="text-[12px] leading-[1.65] text-ink-dim pl-6">{children}</div>
        <div className="pl-6">
          <ConditionButtons actions={actions} dispatch={dispatch} />
        </div>
      </div>
    </div>
  )
}

export const opencodePermissionView = defineView<
  'opencode.permission',
  OpencodePermissionState
>({
  kind: 'opencode.permission',
  layout: 'modal',
  // A tool-permission request demands a decision → ACTION.
  attention: state => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    return (
      <ConditionShell
        heading="OpenCode needs permission"
        actions={actions}
        dispatch={dispatch}
      >
        <p className="mb-2">
          OpenCode is requesting permission
          {state.title ? (
            <>
              {' '}for <span className="text-accent">{state.title}</span>
            </>
          ) : null}
          .
        </p>
      </ConditionShell>
    )
  },
})

export const opencodeQuestionView = defineView<
  'opencode.question',
  OpencodeQuestionState
>({
  kind: 'opencode.question',
  layout: 'modal',
  attention: state => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    return (
      <ConditionShell heading="OpenCode is asking" actions={actions} dispatch={dispatch}>
        {state.text ? (
          <pre className="bg-code-bg text-ink px-3 py-2 mb-1 overflow-x-auto whitespace-pre-wrap text-[11.5px]">
            {state.text}
          </pre>
        ) : (
          <p className="mb-2">OpenCode is waiting for a response.</p>
        )}
      </ConditionShell>
    )
  },
})

// Explicit object literal (not Object.fromEntries) so the per-key
// kind↔view binding is compiler-checked against OpencodeStateByKind via
// eraseRegistry's Partial<ViewRegistry<M>> parameter — see CODEX_VIEWS.
export const OPENCODE_VIEWS: Record<string, ConditionView> =
  eraseRegistry<OpencodeStateByKind>({
    'opencode.permission': opencodePermissionView,
    'opencode.question': opencodeQuestionView,
  })
