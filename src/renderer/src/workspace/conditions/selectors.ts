import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

export function hasActionCondition(
  conditions: ProviderConditionSnapshot | null,
): boolean {
  if (!conditions) return false
  if (conditions.provider === 'claude') {
    return Boolean(
      conditions.conditions['claude.trust-dialog'] ||
      conditions.conditions['claude.resume-prompt'] ||
      conditions.conditions['claude.permission-prompt'],
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
    // ONLY renderer consumer of the new claude.ask-user-question condition in
    // PR-4: a purely informational badge that cannot affect the inline picker's
    // render gate (that stays semantic — `!resultAt`) or its answering path, so
    // it can't regress the working single-select flow. The richer consumers
    // (answerability gate, multi-step driver) land with PR-5.
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
