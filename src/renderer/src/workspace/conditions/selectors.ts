import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

// WHY this predicate exists (conditions audit Finding 2 + Additional A):
// Several call sites used `runtime.conditions !== null` as a proxy for "there is
// a live provider prompt/overlay". That is wrong: a provider can emit a NON-null
// snapshot whose condition map is empty (or contains only dismissed entries), and
// that empty-but-present snapshot would still flip UI layout (e.g. promote a pane
// to Hybrid display). The source of truth is "is any condition actually on
// screen", not "did a snapshot ever arrive". This helper encodes that policy in
// ONE place so headers, display-mode, exit clearing, and status all agree.
//
// Liveness rule per condition kind:
//   - States carrying an explicit `visible: boolean` (trust-dialog, resume-prompt,
//     permission-prompt, compaction, slash-picker) are live iff `visible === true`.
//   - States WITHOUT a `visible` flag (codex.approval, claude.ask-user-question)
//     use record-presence as liveness: the provider includes the record only while
//     the surface is on screen and omits the key otherwise.
export function hasVisibleConditions(
  snapshot: ProviderConditionSnapshot | null,
): boolean {
  if (!snapshot) return false
  // `?? {}` guards against a malformed snapshot lacking a condition map; presence
  // of the snapshot object alone must never be treated as a live condition.
  for (const condition of Object.values(snapshot.conditions ?? {})) {
    if (!condition) continue
    const state = condition.state as { visible?: boolean }
    if (typeof state.visible === 'boolean') {
      if (state.visible) return true
    } else {
      // No `visible` flag → presence is the signal.
      return true
    }
  }
  return false
}

// WHY this exists (conditions audit Finding 2 / roadmap E7):
// Provider condition ids are only valid while the backing process is alive — they
// reference live PTY/parser state on the headless side. When a session exits the
// process is gone, so any unresolved prompt UI (approval, trust, permission,
// resume, compaction, slash picker) that survives in runtime state is stale and
// can present an action surface that no longer maps to a real provider prompt.
// `onSessionExit` already clears stream/semantic/process state but historically
// left condition state attached; this helper is the single hard-clear used there
// so the exit reducer can drop every condition-derived field in lockstep without
// re-listing them (and drifting) at the call site.
//
// NOTE: this clears `conditions` AND the legacy `pending*` mirrors together. The
// mirrors are a compatibility cache derived from the same snapshot (see
// `applyConditionSnapshot`); clearing one without the other is exactly the
// split-authority bug the audit calls out, so they must move as a unit.
export function clearConditionRuntimeState(): Pick<
  SessionRuntime,
  | 'conditions'
  | 'picker'
  | 'pendingApproval'
  | 'pendingTrustDialog'
  | 'pendingResumePrompt'
  | 'pendingPermissionPrompt'
  | 'pendingCompaction'
> {
  return {
    conditions: null,
    picker: { visible: false, items: [] },
    pendingApproval: null,
    pendingTrustDialog: null,
    pendingResumePrompt: null,
    pendingPermissionPrompt: null,
    pendingCompaction: null,
  }
}

// The condition kinds that represent a live, user-actionable prompt the user
// must attend to. EXCLUDES claude.compaction (progress, not actionable) and
// claude.slash-picker (a composer affordance, not an attention surface).
const ATTENTION_CONDITION_KINDS: ReadonlySet<string> = new Set([
  'claude.trust-dialog',
  'claude.resume-prompt',
  'claude.permission-prompt',
  'claude.ask-user-question',
  'codex.trust-dialog',
  'codex.approval',
])

// WHY this exists (conditions audit Finding 5 + Additional B): the unread/
// attention transition in useIpcSubscriptions used to read the legacy `pending*`
// mirrors AND silently excluded AskUserQuestion — so a question, whose ENTIRE
// purpose is to collect user input, never marked a backgrounded pane unread. The
// attention policy must be one selector over the condition snapshot, not a
// hand-maintained mirror list that drifts. This is visibility-aware to MATCH the
// old mirror behavior exactly for trust/resume/permission (which only set the
// mirror when `visible: true`) while ADDING AUQ and codex approval/trust, whose
// states carry no `visible` flag and signal liveness by record-presence.
export function conditionRequiresAttention(
  snapshot: ProviderConditionSnapshot | null,
): boolean {
  if (!snapshot) return false
  for (const [kind, condition] of Object.entries(snapshot.conditions)) {
    if (!condition || !ATTENTION_CONDITION_KINDS.has(kind)) continue
    const state = condition.state as { visible?: boolean }
    if (typeof state.visible === 'boolean' ? state.visible : true) return true
  }
  return false
}

export function hasActionCondition(
  conditions: ProviderConditionSnapshot | null,
): boolean {
  if (!conditions) return false
  if (conditions.provider === 'claude') {
    return Boolean(
      conditions.conditions['claude.trust-dialog'] ||
      conditions.conditions['claude.resume-prompt'] ||
      conditions.conditions['claude.permission-prompt'] ||
      conditions.conditions['claude.ask-user-question'],
    )
  }
  return Boolean(
    conditions.conditions['codex.trust-dialog'] ||
    conditions.conditions['codex.approval'],
  )
}

export function dispatchAttentionLabelFromConditions(
  conditions: ProviderConditionSnapshot | null,
): string | null {
  if (!conditions) return null
  if (conditions.provider === 'claude') {
    if (conditions.conditions['claude.permission-prompt']) return 'ACTION'
    // A live AskUserQuestion picker means the agent is BLOCKED waiting for the
    // user to choose — it needs attention just like a permission/trust prompt,
    // so it surfaces a dispatch badge ('QUESTION') the same way. This is the
    // The inline row still renders from transcript state (`!resultAt`), but this
    // condition is now a real blocking input surface too: keybinding routing uses
    // `hasActionCondition` so arrow keys keep reaching Claude's picker while the
    // user decides from the terminal instead of the feed row.
    if (conditions.conditions['claude.ask-user-question']) return 'QUESTION'
    if (conditions.conditions['claude.trust-dialog']) return 'TRUST'
    if (conditions.conditions['claude.resume-prompt']) return 'RESUME'
    if (conditions.conditions['claude.compaction']?.state.phase === 'error') return 'ERROR'
    return null
  }
  if (conditions.conditions['codex.approval']) return 'ACTION'
  if (conditions.conditions['codex.trust-dialog']) return 'TRUST'
  return null
}

export function slashPickerFromConditions(
  conditions: ProviderConditionSnapshot | null,
) {
  if (conditions?.provider !== 'claude') return null
  return conditions.conditions['claude.slash-picker']?.state ?? null
}
