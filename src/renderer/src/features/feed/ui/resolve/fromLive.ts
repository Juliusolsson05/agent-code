import { asRecord, parseJsonRecord } from '@shared/lib/asRecord'
import type { AgentProviderKind } from '@shared/types/providerKind'

import {
  classifyUnifiedExecScript,
  execCommandInput,
} from '@providers/codex/renderer/extractors'
import {
  prettifyToolName,
  smartHeadline,
} from '@providers/shared/renderer/rows/jsonToolPresentation'

import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type {
  ArtifactStatus,
  CommandArtifact,
  GenericToolArtifact,
} from '@renderer/features/feed/ui/artifacts/types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// Live-plane resolvers: SemanticLiveBlock (+ the turn's per-tool
// snapshot) → the SAME ArtifactVM the committed plane produces. This
// is the convergence seam: whatever a live card can't know yet stays
// null and fills in by props flip when the data arrives; when the
// committed row replaces the live one, it renders the same card from
// the same VM shape.
//
// Status derivation, live plane (spec §4):
//   - input still streaming (not finalized, no result) → 'streaming'
//   - input finalized, snapshot in_progress / no result → 'running'
//   - snapshot error / resultIsError                    → 'error'
//   - result attached                                   → 'complete'

function liveStatus(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
): ArtifactStatus {
  if (toolState?.status === 'error' || block.resultIsError === true) return 'error'
  const hasResult = block.resultAt != null || block.resultContent != null
  if (hasResult && toolState?.status !== 'in_progress') return 'complete'
  if (block.finalized !== true && !hasResult) return 'streaming'
  return 'running'
}

/** Best-effort parsed input from a live block: prefer the finalized
 *  parse, then a full parse of the (possibly complete) buffer. Null
 *  while the JSON is still partial. */
export function liveParsedInput(block: SemanticLiveBlock): Record<string, unknown> | null {
  if (block.parsedInput) return block.parsedInput
  const raw = block.argumentsJson ?? block.inputJson ?? ''
  return raw ? parseJsonRecord(raw) : null
}

export function commandFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): CommandArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const parsed = liveParsedInput(block)

  // Three live command sources, one VM:
  //   - Claude Bash: { command, description } (partial mid-stream —
  //     command may be absent until its JSON string closes)
  //   - Codex exec_command: { cmd|command, workdir, yield_time_ms, … }
  //   - Codex local_shell_call: block.localShellCall metadata (argv
  //     array + workingDirectory), no JSON input at all
  const shell = block.localShellCall
  // Unified `exec` (modern Codex): the streaming buffer is a JS script,
  // not JSON — classify it for the embedded exec_command/write_stdin.
  const unified =
    block.toolName === 'exec'
      ? classifyUnifiedExecScript(block.argumentsJson ?? block.inputJson ?? '')
      : null
  const exec =
    unified?.kind === 'exec_command'
      ? unified.input
      : parsed
        ? execCommandInput(parsed)
        : null
  const command =
    unified?.kind === 'wait'
      ? 'Waited for background terminal'
      : block.toolName === 'wait' || block.toolName === 'wait_terminal'
        ? 'Waited for background terminal'
      : shell?.command?.join(' ') ??
        exec?.command ??
        (typeof parsed?.command === 'string' ? parsed.command : null)

  // Live output: tool_output_delta accumulates into block.resultContent
  // (foldEvent tool_output_delta branch), and the lookup snapshot
  // mirrors it — prefer the snapshot (kept current across block moves).
  const output = toolState?.resultContent ?? block.resultContent ?? null

  return {
    family: 'command',
    id: `cmd:${id}`,
    provider,
    status: liveStatus(block, toolState),
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    command: command ?? '…',
    cwd: shell?.workingDirectory ?? exec?.workdir ?? null,
    description: typeof parsed?.description === 'string' ? parsed.description : null,
    sourceTool:
      unified?.kind === 'wait' || block.toolName === 'wait' || block.toolName === 'wait_terminal'
        ? 'wait'
        : block.kind === 'local_shell_call'
          ? 'local_shell_call'
          : block.toolName === 'write_stdin' || unified?.kind === 'write_stdin'
            ? 'write_stdin'
            : block.toolName === 'Bash'
              ? 'Bash'
              : 'exec_command',
    output,
    // Live exit code is not stored on the block (tool_completed folds
    // it into resultIsError only) — the committed row adds the number.
    exitCode: null,
    durationMs: null,
    yieldTimeMs: exec?.yieldTimeMs ?? null,
    maxOutputTokens: exec?.maxOutputTokens ?? null,
    stdinWrites:
      unified?.kind === 'write_stdin'
        ? [unified.chars]
        : block.toolName === 'write_stdin' && typeof parsed?.chars === 'string'
          ? [parsed.chars]
          : [],
    // parsed_cmd classification only exists on committed result meta.
    parsedRead: null,
  }
}

export function genericFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): GenericToolArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const name = block.toolName ?? block.kind
  const parsed = liveParsedInput(block)
  const pretty = prettifyToolName(name)
  const rawJson = block.argumentsJson ?? block.inputJson ?? ''
  return {
    family: 'generic',
    id: `gen:${id}`,
    provider,
    status: liveStatus(block, toolState),
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    toolName: name,
    prettyName: pretty.display,
    mcp: pretty.mcpServer ? { server: pretty.mcpServer, tool: pretty.display } : null,
    headline: smartHeadline(parsed ?? asRecord(block.parsedInput))?.value ?? null,
    params: parsed,
    paramsJson: parsed ? JSON.stringify(parsed, null, 2) : rawJson,
    parseError: block.parseError ?? null,
    resultText: toolState?.resultContent ?? block.resultContent ?? null,
    resultIsError: block.resultIsError === true,
  }
}
