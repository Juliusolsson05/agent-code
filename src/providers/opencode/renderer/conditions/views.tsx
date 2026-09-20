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
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { withVisibleControls } from '@shared/text/visibleControls'

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
          <Button
            key={action.kind === 'custom' ? action.id : `pty-${i}`}
            type="button"
            autoFocus={i === firstPrimaryIdx}
            onClick={() => {
              void dispatch(action)
            }}
            variant={reject ? 'outline' : 'default'}
          >
            {action.label}
          </Button>
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
    <Dialog open>
      <DialogContent
        className="modal-pop w-[480px] max-w-[calc(100vw-64px)] p-6"
        onEscapeKeyDown={event => event.preventDefault()}
        onPointerDownOutside={event => event.preventDefault()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="text-accent text-[18px] leading-none select-none pt-0.5">!</div>
          <DialogTitle className="text-[14px] font-semibold leading-[1.3]">{heading}</DialogTitle>
          <DialogDescription className="sr-only">
            OpenCode is waiting for an explicit response before it can continue.
          </DialogDescription>
        </div>
        <div className="text-[12px] leading-[1.65] text-ink-dim pl-6">{children}</div>
        <div className="pl-6">
          <ConditionButtons actions={actions} dispatch={dispatch} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The raw permission.asked payload's own `metadata.command`, which is where
 * OpenCode puts the shell command for both `bash` and bash-triggered
 * `external_directory` asks. */
function askedCommand(metadata: unknown): string | undefined {
  const inner = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).metadata : undefined
  const command = inner && typeof inner === 'object' ? (inner as Record<string, unknown>).command : undefined
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

/** The permission kind (`bash`, `edit`, an MCP tool key…) from the payload. */
function askedPermission(metadata: unknown): string | undefined {
  const permission = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).permission : undefined
  return typeof permission === 'string' && permission.length > 0 ? permission : undefined
}

/** The patterns "Allow always" would grant, read from the raw
 * permission.asked payload. Anything that is not a list of non-empty strings
 * yields no scope line; the modal then says nothing about scope rather than
 * guessing. */
function alwaysScope(metadata: unknown): string[] {
  const always = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).always : undefined
  return Array.isArray(always) ? always.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0) : []
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
        {state.title ? (
          <>
            <p className="mb-1">OpenCode is requesting permission for:</p>
            {/* WHY a bounded, scrolling <pre> (#878, opencode-headless#14
                review): the subject is the command the user is approving,
                shown in full because this modal is the ONLY place they see
                it, so it must never be truncated. It can be a 100-line
                heredoc, and DialogContent has no max height, so inline
                prose pushed the buttons off-screen while the auto-focused
                "Allow once" answered Enter. Wrapping keeps a long single-line
                `python3 -c` legible; the height cap keeps the buttons on
                screen. */}
            <pre className="bg-code-bg rounded-slab text-code-ink px-3 py-2 mb-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-[11.5px]">
              {withVisibleControls(state.title)}
            </pre>
          </>
        ) : (
          <p className="mb-2">OpenCode is requesting permission.</p>
        )}
        {(() => {
          // WHY the command gets its own block when the subject lacks it
          // (#1026 review): OpenCode's DEFAULT rules allow `bash` and ask only
          // for `external_directory`. For most users the shell-command prompt
          // therefore reads "external_directory: /work/old/*", while the
          // command that will actually run (`rm -rf /work/old`) sits only in
          // the payload's metadata. The approval must show what executes, not
          // just which folder it touches.
          const command = askedCommand(state.metadata)
          if (!command || (state.title ?? '').includes(command)) return null
          return (
            <>
              <p className="mb-1">Command:</p>
              <pre className="bg-code-bg rounded-slab text-code-ink px-3 py-2 mb-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-[11.5px]">
                {withVisibleControls(command)}
              </pre>
            </>
          )
        })()}
        {(() => {
          // WHY the scope is spelled out: "Allow always" beside
          // `edit: src/a.ts` looks scoped to that file, but OpenCode asks
          // edit/write/MCP with `always: ["*"]`, meaning every such request for
          // the rest of the session. OpenCode's own UI confirms the scope
          // before granting it. Ours showed nothing, so the most permissive
          // button read as the narrowest. The scope is the payload's own
          // `always` list (state.metadata is the raw permission.asked
          // payload).
          const always = alwaysScope(state.metadata)
          if (always.length === 0) return null
          const permission = askedPermission(state.metadata)
          // The reach is worded the way OpenCode's own TUI words it. The grant
          // lives in the OpenCode server's memory: it covers every session on
          // that server, which is this agent AND its subagents (task tool),
          // and it ends when the server does. Agent Code runs one server per
          // agent, so that means "until this agent restarts".
          return (
            <p className="mb-2 text-[11px] break-words">
              {always.includes('*') ? (
                <>
                  Allow always covers{' '}
                  {/* The wildcard branch names the SCOPE the grant will cover,
                      so it is the one a spoofed permission name would misstate
                      most profitably — `*` is the broadest grant we offer
                      (#1049 re-review found this branch unescaped). */}
                  <strong>every {permission ? <code className="text-accent">{withVisibleControls(permission)}</code> : 'such'} request</strong>{' '}
                  from this agent and its subagents until this agent restarts.
                </>
              ) : (
                <>
                  Allow always covers {permission ? <>{withVisibleControls(permission)}{' '}</> : null}
                  {always.map((pattern, index) => (
                    <span key={pattern}>
                      {index > 0 ? ', ' : ''}
                      <code className="text-accent">{withVisibleControls(pattern)}</code>
                    </span>
                  ))}{' '}
                  for this agent and its subagents until this agent restarts.
                </>
              )}
            </p>
          )
        })()}
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
          // Bounded and scrollable for the same reason as the permission
          // subject: the text is now populated (#878), the modal has no max
          // height, and Escape and outside-click are disabled, so a long
          // question must never push the only button (Reject) off-screen.
          <pre className="bg-code-bg rounded-slab text-code-ink px-3 py-2 mb-1 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-[11.5px]">
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
