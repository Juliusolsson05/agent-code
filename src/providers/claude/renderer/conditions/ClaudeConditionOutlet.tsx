import { CompactionStrip } from '@renderer/workspace/tile-tree/TileLeaf/CompactionStrip'
import { PermissionPromptModal } from '@providers/claude/renderer/PermissionPromptModal'
import { ResumePromptModal } from '@providers/claude/renderer/ResumePromptModal'
import { TrustDialogModal } from '@providers/claude/renderer/TrustDialogModal'
import type { ClaudeConditionSnapshot } from '@shared/types/providerConditions'

type Props = {
  conditions: ClaudeConditionSnapshot
  onSend: (data: string) => Promise<void>
}

export function ClaudeConditionOutlet({ conditions, onSend }: Props) {
  const trust = conditions.conditions['claude.trust-dialog']?.state ?? null
  const resume = conditions.conditions['claude.resume-prompt']?.state ?? null
  const permission = conditions.conditions['claude.permission-prompt']?.state ?? null
  const compaction = conditions.conditions['claude.compaction']?.state ?? null

  return (
    <>
      <ResumePromptModal
        prompt={resume?.visible
          ? {
              sessionAgeText: resume.sessionAgeText,
              tokenCountText: resume.tokenCountText,
              selectedIndex: resume.selectedIndex,
            }
          : null}
        onSend={onSend}
      />
      <PermissionPromptModal
        state={permission?.visible
          ? {
              title: permission.title,
              toolName: permission.toolName,
              command: permission.command,
              options: permission.options,
              selectedIndex: permission.selectedIndex,
            }
          : null}
        onSend={onSend}
      />
      <CompactionStrip
        pendingCompaction={compaction?.visible && compaction.phase
          ? {
              phase: compaction.phase,
              statusText: compaction.statusText,
              errorText: compaction.errorText,
            }
          : null}
      />
      <TrustDialogModal
        state={trust?.visible ? { workspace: trust.workspace } : null}
        onSend={onSend}
      />
    </>
  )
}
