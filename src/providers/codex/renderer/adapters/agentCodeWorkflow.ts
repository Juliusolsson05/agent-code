import type { ToolUseBlock } from '@shared/types/transcript'
import { fromAgentCodeWorkflowUse } from '@providers/shared/renderer/protocols/agent-code-workflow/model'

// TODO(agent-code-workflow-capture): historical Codex integrations flatten
// Agent Code MCP tools to bare names, so this provider generation gives us no
// namespace discriminator. The narrow two-name allowlist plus strict required
// fields is the strongest honest boundary available; malformed or differently
// shaped calls still decline to generic. Paired current-generation and replay
// fixtures are required before this path grows phase/agent/coverage-specific
// presentation—or before we can decide whether modern nested MCP-in-exec
// evidence should replace this legacy bare-name admission entirely.
export function fromCodexAgentCodeWorkflowUse(block: ToolUseBlock) {
  if (block.name === 'workflow_run') return fromAgentCodeWorkflowUse(block, 'workflow_run')
  if (block.name === 'workflow_resume') return fromAgentCodeWorkflowUse(block, 'workflow_resume')
  return null
}
