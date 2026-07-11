import { asRecord, parseJsonRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import { codexResultMeta } from '@providers/codex/renderer/extractors'
import {
  prettifyToolName,
  smartHeadline,
} from '@providers/shared/renderer/rows/jsonToolPresentation'

import {
  extractToolCommand,
  toolResultText,
} from '@renderer/features/feed/lib/helpers'
import type {
  ArtifactStatus,
  CommandArtifact,
  GenericToolArtifact,
} from '@renderer/features/feed/ui/artifacts/types'

// Committed-plane resolvers: ToolUseBlock (+ paired ToolResultBlock,
// looked up by the caller via the runtime tool indices) → ArtifactVM.
//
// Status derivation, committed plane (spec §4):
//   - result missing        → 'running' (a committed tool_use whose
//     result hasn't landed yet — the same window the GitCardRow
//     "running…" placeholder covers)
//   - is_error / exit != 0  → 'error'
//   - else                  → 'complete'
// 'streaming' never occurs on this plane: a committed tool_use always
// carries its full input.

function committedStatus(
  result: ToolResultBlock | null,
  exitCode: number | null,
): ArtifactStatus {
  if (!result) return 'running'
  if (result.is_error === true) return 'error'
  if (exitCode !== null && exitCode !== 0) return 'error'
  return 'complete'
}

export function commandFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): CommandArtifact {
  const input = asRecord(tu.input)
  const { exitCode, cwd: metaCwd } = codexResultMeta(result)
  const stdin =
    tu.name === 'write_stdin' && typeof input?.chars === 'string'
      ? [input.chars]
      : []
  return {
    family: 'command',
    id: `cmd:${tu.id}`,
    provider,
    status: committedStatus(result, exitCode),
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    command:
      tu.name === 'write_stdin'
        ? '(stdin)'
        : extractToolCommand(tu) ?? '(no command)',
    cwd:
      metaCwd ??
      (typeof input?.workdir === 'string'
        ? input.workdir
        : typeof input?.cwd === 'string'
          ? input.cwd
          : null),
    description:
      typeof input?.description === 'string' ? input.description : null,
    sourceTool: (tu.name === 'Bash' ||
      tu.name === 'bash' ||
      tu.name === 'exec_command' ||
      tu.name === 'local_shell_call' ||
      tu.name === 'write_stdin'
      ? tu.name
      : 'Bash') as CommandArtifact['sourceTool'],
    output: result ? toolResultText(result) : null,
    exitCode,
    durationMs: null,
    yieldTimeMs:
      typeof input?.yield_time_ms === 'number' ? input.yield_time_ms : null,
    maxOutputTokens:
      typeof input?.max_output_tokens === 'number'
        ? input.max_output_tokens
        : null,
    stdinWrites: stdin,
  }
}

export function genericFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): GenericToolArtifact {
  const params =
    asRecord(tu.input) ??
    (typeof tu.input === 'string' ? parseJsonRecord(tu.input) : null)
  const pretty = prettifyToolName(tu.name)
  return {
    family: 'generic',
    id: `gen:${tu.id}`,
    provider,
    status: committedStatus(result, null),
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    toolName: tu.name,
    prettyName: pretty.display,
    mcp: pretty.mcpServer ? { server: pretty.mcpServer, tool: pretty.display } : null,
    headline: smartHeadline(params)?.value ?? null,
    params,
    paramsJson: params ? JSON.stringify(params, null, 2) : String(tu.input ?? ''),
    parseError: null,
    resultText: result ? toolResultText(result) : null,
    resultIsError: result?.is_error === true,
  }
}
