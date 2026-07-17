import type { ReactNode } from 'react'
import {
  applyPatchText,
  fromCodexApplyPatch,
  isCodexApplyPatchUse,
} from '@providers/codex/renderer/adapters/codeEdit'
import {
  fromCodexExecCommand,
  fromCodexExecScript,
} from '@providers/codex/renderer/adapters/command'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
// Provider-internal imports reach component directories directly. Phase 9
// removed the old CodexRows feed barrel after live semantic dispatch moved
// behind the registry capability; provider vocabulary must not leak back into
// the shared feed.
import { CodexApplyPatchRow } from '@providers/codex/renderer/components/apply-patch'
import { CodexToolResultRow } from '@providers/codex/renderer/components/tool-result'
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
import { asRecord } from '@shared/lib/asRecord'
import type {
  ProviderOperationDecision,
  ProviderOperationInput,
  ProviderSpecializedReceipt,
} from '@shared/types/providerConfig'
import { fromCodexGitOperation } from '@providers/codex/renderer/adapters/git'
import { GitOperationView } from '@providers/shared/renderer/protocols/command/formatters/git'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

function codexOperationReceipt(toolUse: ToolUseBlock): ProviderSpecializedReceipt {
  // Receipt protocol ids are proof-bearing claims. Only our source-controlled
  // Agent Code adapters may mint them; open-world MCP and generated exec
  // shapes remain ordinary Codex specialization or the shared fallback.
  if (fromCodexAgentCodeOrchestrationUse(toolUse)) {
    return { rendererId: 'codex.rows.dispatch', protocolId: 'agent-code.orchestration' }
  }
  if (fromCodexAgentCodeWorkspaceUse(toolUse)) {
    return { rendererId: 'codex.rows.dispatch', protocolId: 'agent-code.workspace' }
  }
  return { rendererId: 'codex.rows.dispatch' }
}

export function renderCodexOperation(
  input: ProviderOperationInput,
): ProviderOperationDecision {
  const git = fromCodexGitOperation(input)
  if (git) {
    return {
      toolUse: {
        action: 'render',
        node: <GitOperationView model={git} />,
        receipt: { rendererId: 'shared.command', protocolId: 'command.git' },
      },
      toolResult: input.result
        ? {
            action: 'absorb',
            ownerRenderId: 'shared.command',
            protocolId: 'command.git',
            reason: 'paired Git operation view preserves the bounded result evidence',
          }
        : null,
    }
  }

  const toolUse = renderCodexToolUse(input.toolUse, {
    live: input.live,
    streaming: input.streaming,
    result: input.result,
  })
  const toolResult = input.result
    ? renderCodexToolResult(input.result, { sourceTool: input.toolUse })
    : undefined
  const toolInput = asRecord(input.toolUse.input)
  const emptyContinuationPoll = input.toolUse.name === 'write_stdin' &&
    (typeof toolInput?.chars !== 'string' || toolInput.chars.length === 0)
  const receipt = codexOperationReceipt(input.toolUse)
  return {
    toolUse: emptyContinuationPoll
      ? {
          action: 'absorb',
          ownerRenderId: 'codex.command-continuation',
          protocolId: 'command.continuation',
          reason: 'empty write_stdin is a transport poll owned by the running command surface',
        }
      : toolUse === undefined
      ? { action: 'fallback' }
      : {
          action: 'render',
          node: toolUse,
          receipt,
        },
    toolResult: !input.result
      ? null
      : toolResult === undefined
        ? { action: 'fallback' }
        : toolResult === null
          ? emptyContinuationPoll
            ? {
                action: 'absorb',
                ownerRenderId: 'codex.command-continuation',
                protocolId: 'command.continuation',
                reason: 'empty poll acknowledgement belongs to the already-running command surface',
              }
            : {
                action: 'absorb',
                ownerRenderId: receipt.rendererId,
                ...(receipt.protocolId ? { protocolId: receipt.protocolId } : {}),
                reason: 'provider operation card validated and consumed its paired result',
              }
          : {
              action: 'render',
              node: toolResult,
              receipt,
            },
  }
}

function renderCodexToolUse(
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
  if (block.name === 'apply_patch') {
    const model = fromCodexApplyPatch(block, {
      streaming: context.streaming,
      running: context.live === true && !context.streaming && context.result == null,
      result: context.result,
    })
    return model
      ? <CodexApplyPatchRow model={model} rawPatch={applyPatchText(block.input)} />
      : undefined
  }
  // Modern unified-exec wrappers may hide a patch inside the script
  // (tools.apply_patch("*** Begin Patch…")). Admission has to happen here,
  // before React is involved: a component returning null after dispatch has
  // already claimed the row would make the evidence receipt lie about which
  // renderer actually owned it. Plain scripts therefore continue past this
  // block to command admission or the shared structured fallback.
  if (block.name === 'exec' && isCodexApplyPatchUse(block, { streamingPrefix: context.streaming === true })) {
    const model = fromCodexApplyPatch(block, {
      streaming: context.streaming,
      running: context.live === true && !context.streaming && context.result == null,
      result: context.result,
    })
    return model
      ? <CodexApplyPatchRow model={model} rawPatch={applyPatchText(block.input)} />
      : undefined
  }
  // …and its plain-command case (Phase 6): extract every embedded
  // tools.exec_command call and render a real command card. Scripts with
  // neither patch nor command intent still fall to the generic row.
  if (block.name === 'exec') {
    const model = fromCodexExecScript(block)
    if (model) return <CommandView model={model} />
  }
  if (block.name === 'exec_command') {
    const model = fromCodexExecCommand(block, { streaming: context.streaming })
    return model ? <CommandView model={model} /> : undefined
  }
  if (block.name === 'write_stdin') return <CodexWriteStdinRow block={block} />
  // Unknown names deliberately fall through to the SHARED fallback
  // (JsonToolRow via Block.tsx) — the residue-plan P1 convergence. Codex
  // used to claim everything with CodexToolRow, which is why its MCP /
  // orchestration tools drifted into "name + one headline over a raw
  // blob" while claude's fell to a different fallback with different
  // gaps. One fallback, one behavior, all providers.
  return undefined
}

function renderCodexToolResult(
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
  const source = context.sourceTool
  if (!source || source.id !== block.tool_use_id) return undefined
  const codex = asRecord(asRecord(block)?.codex)
  const kind = typeof codex?.kind === 'string' ? codex.kind : null
  const resultText = toolResultContentText(block.content).trim()
  // These previously returned null from inside CodexToolResultRow, after the
  // operation boundary had already recorded a specialized paint. Decide here
  // so every vanished row has a named absorption receipt.
  if (block.is_error !== true && kind === 'patch_apply_end') return null
  if (block.is_error !== true && kind === 'exec_command_end' && resultText === '') return null
  if (
    block.is_error !== true &&
    source.name === 'write_stdin' &&
    resultText === ''
  ) return null
  const providerOperation =
    source.name === 'exec' ||
    source.name === 'exec_command' ||
    source.name === 'write_stdin' ||
    source.name === 'apply_patch'
  const providerEnvelope =
    kind === 'exec_command_end' ||
    kind === 'patch_apply_end' ||
    kind === 'custom_tool_call_output'
  // A result is Codex-owned because its correlated invocation or explicit
  // metadata proves the Codex transport grammar—not merely because the pane
  // happens to run Codex. Native collaboration, open-world MCP, image, and
  // future results deliberately decline to the one shared JSON/MCP fallback.
  return providerOperation || providerEnvelope
    ? <CodexToolResultRow block={block} sourceTool={source} />
    : undefined
}
