import { toClaude, toCodex } from 'agent-transcript-parser'
import type { ClaudeEntry, CodexRolloutLine } from 'agent-transcript-parser'

import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  getCodexSessionId,
  getClaudeSessionId,
  readJsonlFile,
  writeClaudeSessionFile,
  writeCodexRolloutFile,
} from './shared.js'

export type SwitchProviderRequest = {
  sourceKind: 'claude' | 'codex'
  sourceProviderSessionId: string
  cwd: string
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
  const sourceFilePath = await getClaudeSessionFilePath(
    request.cwd,
    request.sourceProviderSessionId,
  )
  const sourceEntries = await readJsonlFile<ClaudeEntry>(sourceFilePath)
  // `dropClaudeBootstrap` strips Claude's self-injected system-reminder
  // burst (tool list, MCP instructions, skill/todo reminders) before the
  // rollout reaches Codex. Without it, the very first lines the resumed
  // Codex agent sees are a giant commentary block the user never wrote,
  // which pollutes the conversation and Codex's title/listing heuristics.
  // Round-trip fidelity isn't a goal on provider-switch — the user has
  // already committed to living inside Codex from here on.
  const translated = toCodex(sourceEntries, {
    lossy: false,
    dropClaudeBootstrap: true,
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
  const targetFilePath = await writeClaudeSessionFile(request.cwd, translated)

  return {
    targetKind: 'claude',
    targetProviderSessionId,
    targetFilePath,
  }
}
