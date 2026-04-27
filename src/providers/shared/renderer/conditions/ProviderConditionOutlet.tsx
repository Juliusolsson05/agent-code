import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { ClaudeConditionOutlet } from '@providers/claude/renderer/conditions/ClaudeConditionOutlet'
import { CodexConditionOutlet } from '@providers/codex/renderer/conditions/CodexConditionOutlet'

type Props = {
  conditions: ProviderConditionSnapshot | null
  onSend: (data: string) => Promise<void>
}

export function ProviderConditionOutlet({ conditions, onSend }: Props) {
  if (!conditions) return null
  if (conditions.provider === 'claude') {
    return <ClaudeConditionOutlet conditions={conditions} onSend={onSend} />
  }
  return <CodexConditionOutlet conditions={conditions} onSend={onSend} />
}
