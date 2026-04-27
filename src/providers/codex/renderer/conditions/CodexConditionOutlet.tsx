import { CodexApprovalModal } from '@providers/codex/renderer/CodexApprovalModal'
import { CodexTrustDialogModal } from '@providers/codex/renderer/conditions/CodexTrustDialogModal'
import type { CodexConditionSnapshot } from '@shared/types/providerConditions'

type Props = {
  conditions: CodexConditionSnapshot
  onSend: (data: string) => Promise<void>
}

export function CodexConditionOutlet({ conditions, onSend }: Props) {
  const trust = conditions.conditions['codex.trust-dialog']?.state ?? null
  const approval = conditions.conditions['codex.approval']?.state ?? null

  return (
    <>
      <CodexApprovalModal
        approval={approval
            ? {
              callId: approval.callId ?? null,
              command: approval.commandParts ?? (approval.command ? approval.command.split(/\s+/) : []),
              workdir: approval.workdir ?? null,
              reason: approval.reason,
              options: approval.options,
              selectedIndex: approval.selectedIndex,
            }
          : null}
        onSend={onSend}
      />
      <CodexTrustDialogModal
        state={trust?.visible ? { workspace: trust.workspace } : null}
        onSend={onSend}
      />
    </>
  )
}
