import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'

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
