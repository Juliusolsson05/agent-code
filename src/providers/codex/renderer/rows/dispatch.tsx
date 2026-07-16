import type { ReactNode } from 'react'
import { applyPatchText } from '@providers/codex/renderer/adapters/codeEdit'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import {
  CodexApplyPatchRow,
  CodexExecCommandRow,
  CodexToolResultRow,
  CodexToolRow,
  CodexWriteStdinRow,
} from '@providers/codex/renderer/rows/CodexRows'

export function renderCodexToolUse(block: ToolUseBlock): ReactNode | undefined {
  // WHY Codex falls back to CodexToolRow here instead of shared ToolUseRow:
  // the Codex row understands Codex's function-call payload conventions and
  // has provider-specific headline extraction for arguments/raw patches. The
  // shared fallback remains for providers that do not claim a tool name.
  if (block.name === 'apply_patch') return <CodexApplyPatchRow block={block} />
  // Modern unified-exec wrapper: a patch may hide inside the exec script
  // (tools.apply_patch("*** Begin Patch…")). CodexApplyPatchRow decodes the
  // embedded literal and falls back to the generic CodexToolRow when the
  // script is a plain command — so routing exec here is strictly additive.
  if (block.name === 'exec' && applyPatchText(block.input).includes('*** Begin Patch'))
    return <CodexApplyPatchRow block={block} />
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
  // WHY both spawn names are suppressed here (not just spawn_agent):
  // Codex fans out through TWO tool names — the native `spawn_agent`
  // function_call AND the bare `orchestration_create_agent` (the MCP
  // orchestration spawn whose `mcp__` prefix Codex strips on the wire). The
  // registry's codex isSpawnTool treats BOTH as spawns and routes them to a
  // TaskSubagentRow. Both spawn results are the renderer join payload
  // ({agent_id,nickname}), not the child agent's work; once the spawn call
  // owns a card, painting that raw JSON below it is noisy and misleading —
  // wait_agent and child notifications carry the user-relevant completion
  // state instead.
  //
  // This list MUST stay in lockstep with codexCapabilities.isSpawnTool in
  // registry.renderer.capabilities.ts: any name classified as a spawn there
  // gets a card, so its result must be suppressed here or the JSON re-appears
  // below the card (the exact regression this fixes for orchestration_create_agent).
  // We inline the names rather than call getRendererProviderCapabilities('codex')
  // .isSpawnTool because that registry module IMPORTS renderCodexToolResult from
  // this file — importing it back would form a runtime import cycle.
  const spawnToolName = context.sourceTool?.name
  if (spawnToolName === 'spawn_agent' || spawnToolName === 'orchestration_create_agent') {
    return null
  }
  return <CodexToolResultRow block={block} />
}
