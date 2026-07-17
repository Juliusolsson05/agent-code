import type { ReactNode } from 'react'
import { isCodexApplyPatchUse } from '@providers/codex/renderer/adapters/codeEdit'
import { fromCodexExecScript } from '@providers/codex/renderer/adapters/command'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
// Provider-internal imports reach component directories directly. Phase 9
// removed the old CodexRows feed barrel after live semantic dispatch moved
// behind the registry capability; provider vocabulary must not leak back into
// the shared feed.
import { CodexApplyPatchRow } from '@providers/codex/renderer/components/apply-patch'
import { CodexExecCommandRow } from '@providers/codex/renderer/components/exec-command'
import { CodexToolResultRow } from '@providers/codex/renderer/components/tool-result'
import { CodexToolRow } from '@providers/codex/renderer/components/tool'
import { CodexWriteStdinRow } from '@providers/codex/renderer/components/write-stdin'
import { AgentCodeOrchestrationView } from '@providers/shared/renderer/protocols/agent-code-orchestration/AgentCodeOrchestrationView'
import { fromAgentCodeOrchestrationResult } from '@providers/shared/renderer/protocols/agent-code-orchestration/model'
import { fromCodexAgentCodeOrchestrationUse } from '@providers/codex/renderer/adapters/agentCodeOrchestration'
import { fromCodexWebUse } from '@providers/codex/renderer/adapters/web'
import { CodexWebRow } from '@providers/codex/renderer/components/web'
import { fromCodexNativeSpawnUse } from '@providers/codex/renderer/adapters/collaboration'
import { CodexNativeSpawnRow } from '@providers/codex/renderer/components/native-spawn'
import { fromCodexAgentCodeWorkspaceUse } from '@providers/codex/renderer/adapters/agentCodeWorkspace'
import { AgentCodeWorkspaceView } from '@providers/shared/renderer/protocols/agent-code-workspace/AgentCodeWorkspaceView'
import { fromAgentCodeWorkspaceResult } from '@providers/shared/renderer/protocols/agent-code-workspace/model'
import { fromCodexPlanUse, isCodexPlanResult } from '@providers/codex/renderer/adapters/tasks'
import { CodexPlanRow } from '@providers/codex/renderer/components/update-plan'
import { fromCodexAgentCodeWorkflowUse } from '@providers/codex/renderer/adapters/agentCodeWorkflow'
import { AgentCodeWorkflowView } from '@providers/shared/renderer/protocols/agent-code-workflow/AgentCodeWorkflowView'
import { fromAgentCodeWorkflowResult } from '@providers/shared/renderer/protocols/agent-code-workflow/model'
import { fromCodexImageGenerationUse } from '@providers/codex/renderer/adapters/imageGeneration'
import { CodexImageGenerationRow } from '@providers/codex/renderer/components/image-generation'

export function renderCodexToolUse(
  block: ToolUseBlock,
  context: { live?: boolean; streaming?: boolean; result?: ToolResultBlock | null } = {},
): ReactNode | undefined {
  const agentCodeOrchestration = fromCodexAgentCodeOrchestrationUse(block)
  if (agentCodeOrchestration) {
    return <AgentCodeOrchestrationView model={agentCodeOrchestration} />
  }
  const agentCodeWorkspace = fromCodexAgentCodeWorkspaceUse(block)
  if (agentCodeWorkspace) {
    return <AgentCodeWorkspaceView model={agentCodeWorkspace} />
  }
  const agentCodeWorkflow = fromCodexAgentCodeWorkflowUse(block)
  if (agentCodeWorkflow) {
    return <AgentCodeWorkflowView model={agentCodeWorkflow} />
  }
  const plan = fromCodexPlanUse(block)
  if (plan) return <CodexPlanRow model={plan} />
  const imageGeneration = fromCodexImageGenerationUse(block)
  if (imageGeneration) return <CodexImageGenerationRow model={imageGeneration} />
  const web = fromCodexWebUse(block)
  if (web) return <CodexWebRow model={web} />
  const nativeSpawn = fromCodexNativeSpawnUse(block)
  if (nativeSpawn) return <CodexNativeSpawnRow model={nativeSpawn} />
  // Provider-specific components below claim only grammars with evidence.
  // Every other Codex function call returns undefined at the end and reaches
  // the same bounded JsonToolRow used by other providers.
  if (block.name === 'apply_patch') return (
    <CodexApplyPatchRow
      block={block}
      streaming={context.streaming}
      running={context.live === true && !context.streaming && context.result == null}
      result={context.result}
    />
  )
  // Modern unified-exec wrapper: a patch may hide inside the exec script
  // (tools.apply_patch("*** Begin Patch…")). CodexApplyPatchRow decodes the
  // embedded literal and falls back to the generic CodexToolRow when the
  // script is a plain command — so routing exec here is strictly additive.
  if (block.name === 'exec' && isCodexApplyPatchUse(block, { streamingPrefix: context.streaming === true }))
    return (
      <CodexApplyPatchRow
        block={block}
        streaming={context.streaming}
        running={context.live === true && !context.streaming && context.result == null}
        result={context.result}
      />
    )
  // …and its plain-command case (Phase 6): extract every embedded
  // tools.exec_command call and render a real command card. Scripts with
  // neither patch nor command intent still fall to the generic row.
  if (block.name === 'exec') {
    const model = fromCodexExecScript(block)
    if (model) return <CommandView model={model} />
  }
  if (block.name === 'exec_command') return <CodexExecCommandRow block={block} />
  if (block.name === 'write_stdin') return <CodexWriteStdinRow block={block} />
  // Unknown names deliberately fall through to the SHARED fallback
  // (JsonToolRow via Block.tsx) — the residue-plan P1 convergence. Codex
  // used to claim everything with CodexToolRow, which is why its MCP /
  // orchestration tools drifted into "name + one headline over a raw
  // blob" while claude's fell to a different fallback with different
  // gaps. One fallback, one behavior, all providers.
  return undefined
}

export function renderCodexToolResult(
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  const agentCodeOrchestration = context.sourceTool
    ? fromCodexAgentCodeOrchestrationUse(context.sourceTool)
    : null
  if (agentCodeOrchestration) {
    return fromAgentCodeOrchestrationResult(block, agentCodeOrchestration)
      ? null
      : undefined
  }
  const agentCodeWorkspace = context.sourceTool
    ? fromCodexAgentCodeWorkspaceUse(context.sourceTool)
    : null
  if (agentCodeWorkspace) {
    return fromAgentCodeWorkspaceResult(block, agentCodeWorkspace)
      ? null
      : undefined
  }
  const agentCodeWorkflow = context.sourceTool
    ? fromCodexAgentCodeWorkflowUse(context.sourceTool)
    : null
  if (agentCodeWorkflow) {
    return fromAgentCodeWorkflowResult(block, agentCodeWorkflow)
      ? null
      : undefined
  }
  const plan = context.sourceTool ? fromCodexPlanUse(context.sourceTool) : null
  if (plan) return isCodexPlanResult(block, plan) ? null : undefined
  // Native spawn results stay visible. They are small handle/identity payloads
  // whose exact fields have changed across Codex generations; the invocation
  // card uses result presence only for terminal status and lets the structured
  // fallback preserve the actual handle. Agent Code MCP results are the only
  // absorbed branch above because that same card includes a raw protocol
  // disclosure backed by the schema we own.
  return <CodexToolResultRow block={block} sourceTool={context.sourceTool} />
}
