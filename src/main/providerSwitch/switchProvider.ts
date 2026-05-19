import { toClaude, toCodex } from 'agent-transcript-parser'
import type { ClaudeEntry, CodexRolloutLine } from 'agent-transcript-parser'

import { sanitizeClaudeEntriesForResume } from '@main/providerSwitch/claudeResumeSanitizer.js'
import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  getCodexSessionId,
  getClaudeSessionId,
  readJsonlFile,
  writeClaudeSessionFile,
  writeCodexRolloutFile,
} from '@main/providerSwitch/shared.js'

export type SwitchProviderRequest = {
  sourceKind: 'claude' | 'codex'
  sourceProviderSessionId: string
  cwd: string
  sourceCwd?: string
  targetCwd?: string
}

export type SwitchProviderResult = {
  targetKind: 'claude' | 'codex'
  targetProviderSessionId: string
  targetFilePath: string
}

export async function switchProvider(
  request: SwitchProviderRequest,
): Promise<SwitchProviderResult> {
  if (request.sourceKind === 'claude') {
    return switchClaudeToCodex(request)
  }
  return switchCodexToClaude(request)
}

async function switchClaudeToCodex(
  request: SwitchProviderRequest,
): Promise<SwitchProviderResult> {
  const sourceCwd = request.sourceCwd ?? request.cwd
  const sourceFilePath = await getClaudeSessionFilePath(
    sourceCwd,
    request.sourceProviderSessionId,
  )
  const sourceEntries = await readJsonlFile<ClaudeEntry>(sourceFilePath)
  // `dropClaudeBootstrap` strips Claude's self-injected system-reminder
  // burst (tool list, MCP instructions, skill/todo reminders) before the
  // rollout reaches Codex. Without it, the very first lines the resumed
  // Codex agent sees are a giant commentary block the user never wrote,
  // which pollutes the conversation and Codex's title/listing heuristics.
  //
  // `sanitizeForResume` strips codex-origin sidecars carrying one-shot
  // history mutations (thread_rolled_back, turn_aborted, compacted with
  // a stale replacement_history). Without this, any codex-event that
  // made it into the Claude JSONL via a prior Codex→Claude switch gets
  // re-emitted into the new rollout, and codex's resume re-applies the
  // mutation — observed as the user "jumping back N messages" after a
  // switch (e.g. a past `/rollback 2` in a source codex session
  // triggers drop_last_n_user_turns on every subsequent resume).
  //
  // Round-trip fidelity isn't a goal on provider-switch — the user has
  // already committed to living inside Codex from here on.
  const translated = toCodex(sourceEntries, {
    lossy: false,
    dropClaudeBootstrap: true,
    sanitizeForResume: true,
  })
  const targetProviderSessionId = getCodexSessionId(translated)
  const targetFilePath = await writeCodexRolloutFile(translated)

  return {
    targetKind: 'codex',
    targetProviderSessionId,
    targetFilePath,
  }
}

async function switchCodexToClaude(
  request: SwitchProviderRequest,
): Promise<SwitchProviderResult> {
  const sourceFilePath = await findCodexRolloutPathBySessionId(
    request.sourceProviderSessionId,
  )
  if (!sourceFilePath) {
    throw new Error(
      `Codex rollout for session ${request.sourceProviderSessionId} was not found.`,
    )
  }

  const sourceLines = await readJsonlFile<CodexRolloutLine>(sourceFilePath)
  const translated = toClaude(sourceLines, { lossy: false })
  const targetProviderSessionId = getClaudeSessionId(translated)
  const targetFilePath = await writeClaudeSessionFile(
    request.targetCwd ?? request.cwd,
    sanitizeClaudeEntriesForResume(translated),
  )

  return {
    targetKind: 'claude',
    targetProviderSessionId,
    targetFilePath,
  }
}
