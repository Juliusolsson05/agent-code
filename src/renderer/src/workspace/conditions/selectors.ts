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
    conditions.conditions['codex.approval'] ||
    conditions.conditions['codex.switch-model-prompt'],
  )
}

export function dispatchAttentionLabelFromConditions(
  conditions: ProviderConditionSnapshot | null,
): string | null {
  if (!conditions) return null
  if (conditions.provider === 'claude') {
    if (conditions.conditions['claude.permission-prompt']) return 'ACTION'
    if (conditions.conditions['claude.trust-dialog']) return 'TRUST'
    if (conditions.conditions['claude.resume-prompt']) return 'RESUME'
    if (conditions.conditions['claude.compaction']?.state.phase === 'error') return 'ERROR'
    return null
  }
  if (conditions.conditions['codex.approval']) return 'ACTION'
  if (conditions.conditions['codex.switch-model-prompt']) return 'ACTION'
  if (conditions.conditions['codex.trust-dialog']) return 'TRUST'
  return null
}

export function slashPickerFromConditions(
  conditions: ProviderConditionSnapshot | null,
) {
  if (conditions?.provider !== 'claude') return null
  return conditions.conditions['claude.slash-picker']?.state ?? null
}
