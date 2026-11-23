// Antigravity condition views: the tool-permission card.
//
// WHY the buttons come straight from `actions`: AntigravitySession builds one
// custom action per option agy offered in session/request_permission, so the
// runtime decides which choices exist (agy 1.5.15 offers Allow / Deny; a later
// agy may add "always"), and the view stays dumb — the same rule as OpenCode's
// permission view.

import { defineView, eraseRegistry } from '@shared/conditions-core/view'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ConditionAction } from '@shared/conditions-core/contract'
import { withVisibleControls } from '@shared/text/visibleControls'
import { ConditionPromptShell } from '@providers/shared/renderer/conditions/ConditionPromptShell'

export type AntigravityPermissionState = {
  visible: boolean
  requestKey: string
  toolCallId: string | null
  title: string
  toolName: string | null
  toolKind: string | null
  input: unknown
  options: Array<{ optionId: string; name: string; kind: string }>
  queued: number
}

type AntigravityStateByKind = {
  'antigravity.permission': AntigravityPermissionState
}

function isRejectAction(action: ConditionAction): boolean {
  return /reject|deny|decline/i.test(action.label)
}

/** The command a shell tool will run, from agy's recorded run_command input. */
function commandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const command = record.CommandLine ?? record.command ?? record.cmd
  return typeof command === 'string' && command.length > 0 ? command : null
}

export const antigravityPermissionView = defineView<'antigravity.permission', AntigravityPermissionState>({
  kind: 'antigravity.permission',
  layout: 'modal',
  // A tool-permission request demands a decision → ACTION.
  attention: state => (state?.visible ? 'ACTION' : null),
  Component: ({ state, actions, dispatch }) => {
    if (!state?.visible) return null
    const command = commandOf(state.input)
    return (
      <ConditionPromptShell
        heading="Antigravity needs permission"
        description="Antigravity is waiting for your answer before it continues this turn."
        actions={actions}
        dispatch={dispatch}
        isReject={isRejectAction}
      >
        <p className="mb-1">{state.toolName ? `${state.toolName}:` : 'Tool:'}</p>
        {/* Bounded and scrolling, never truncated: this card is the only place
            the user sees what they approve (same reasoning as OpenCode's). */}
        <pre className="bg-code-bg rounded-slab text-code-ink px-3 py-2 mb-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-[11px]">
          {withVisibleControls(command ?? state.title)}
        </pre>
        {state.queued > 0 ? <p className="text-[11px] opacity-70">{state.queued} more request{state.queued === 1 ? '' : 's'} waiting.</p> : null}
      </ConditionPromptShell>
    )
  },
})

export const ANTIGRAVITY_VIEWS: Record<string, ConditionView> = eraseRegistry<AntigravityStateByKind>({
  'antigravity.permission': antigravityPermissionView,
})
