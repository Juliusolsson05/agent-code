import { randomUUID } from 'node:crypto'

import { cloneClaudeTranscript, toClaude, toCodex } from 'agent-transcript-parser'
import type { ClaudeEntry, CodexRolloutLine } from 'agent-transcript-parser'
import { isRecord } from '@shared/lib/asRecord.js'

import { sanitizeClaudeEntriesForResume } from '@main/providerSwitch/claudeResumeSanitizer.js'
import { sanitizeCodexRolloutForResume } from '@main/providerSwitch/codexResumeSanitizer.js'
import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  getCodexSessionId,
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
  const translated = toCodex(sanitizeClaudeEntriesForResume(sourceEntries), {
    lossy: false,
    dropClaudeBootstrap: true,
    sanitizeForResume: true,
    targetSessionId: randomUUID(),
  })
  const targetProviderSessionId = getCodexSessionId(translated)
  const targetFilePath = await writeCodexRolloutFile(
    sanitizeCodexRolloutForResume(translated),
  )

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
  // WHY retarget after translation instead of teaching `toClaude` to always
  // allocate a new id:
  // `toClaude` is also the byte-fidelity export/round-trip converter, where
  // preserving the source identity is useful and already covered by fixtures.
  // Provider switching is different: the output is a live Claude transcript
  // that will be resumed immediately. Reusing the Codex thread id means the
  // child can report the same inherited id as its parent and, worse, Claude is
  // asked to resume a transcript whose identity belongs to another provider.
  // Retargeting here keeps export semantics untouched while making the live
  // transcript obey the provider-switch contract: new file, new provider id.
  const { entries: retargeted, newSessionId: targetProviderSessionId } =
    cloneClaudeTranscript(translated, {
      newSessionId: randomUUID(),
      titleSuffix: null,
    })
  const resumeSafeEntries = prepareTranslatedClaudeForResume(
    retargeted,
    targetProviderSessionId,
  )
  const targetFilePath = await writeClaudeSessionFile(
    request.targetCwd ?? request.cwd,
    sanitizeClaudeEntriesForResume(resumeSafeEntries),
  )

  return {
    targetKind: 'claude',
    targetProviderSessionId,
    targetFilePath,
  }
}

function prepareTranslatedClaudeForResume(
  entries: readonly ClaudeEntry[],
  sessionId: string,
): ClaudeEntry[] {
  // WHY provider-switch cannot write the raw `toClaude()` output:
  // `toClaude()` is a fidelity converter. It emits Codex sidecar sentinels as
  // Claude `system` records (`codex_session_meta`, `codex_turn_context`,
  // `codex_event_msg`) so a later Claude->Codex export can round-trip bytes.
  // Claude Code's own `--resume` loader is stricter than our transcript reader:
  // it rejects those translated records and also expects assistant entries to
  // carry a native Anthropic message envelope (`type`, `model`, `stop_reason`,
  // `usage`, and a top-level `requestId`). Without this normalization the PTY
  // exits immediately with only "Failed to resume session <id>", before prompt
  // delivery has any chance to matter.
  //
  // Provider-switch/orchestration is a live-resume path, not an export path, so
  // resumability wins over byte-fidelity here. Keep only real conversation
  // turns, rethread them into one linear parent chain, synthesize Claude's
  // lightweight resume metadata, and wrap assistant messages enough for the
  // native loader to accept the file. The original Codex source remains
  // untouched on disk, so lossy resume shaping here does not destroy history.
  const conversation = entries
    .filter(entry => entry.type === 'user' || entry.type === 'assistant')
    .map((entry, index, arr): ClaudeEntry => {
      const next: ClaudeEntry = {
        ...entry,
        sessionId,
        parentUuid: index === 0 ? null : arr[index - 1]?.uuid ?? null,
      }
      if (next.type === 'assistant' && next.message) {
        const message = next.message as Record<string, unknown>
        const content = Array.isArray(message.content)
          ? message.content
          : [{ type: 'text', text: String(message.content ?? '') }]
        next.requestId =
          typeof next.requestId === 'string' && next.requestId.length > 0
            ? next.requestId
            : `req_${String(next.uuid ?? randomUUID()).replace(/-/g, '').slice(0, 24)}`
        next.message = {
          type: 'message',
          model: typeof message.model === 'string' ? message.model : 'claude-opus-4-7',
          id: typeof message.id === 'string' ? message.id : `msg_${String(next.uuid ?? randomUUID()).replace(/-/g, '')}`,
          role: 'assistant',
          content,
          stop_reason: typeof message.stop_reason === 'string'
            ? message.stop_reason
            : 'end_turn',
          stop_sequence: message.stop_sequence ?? null,
          stop_details: message.stop_details ?? null,
          usage: isRecord(message.usage)
            ? message.usage
            : {
                input_tokens: 1,
                output_tokens: 1,
              },
        } as ClaudeEntry['message']
      }
      return next
    })

  const leafUuid = conversation.at(-1)?.uuid
  const prefix: ClaudeEntry[] = []
  if (typeof leafUuid === 'string' && leafUuid.length > 0) {
    prefix.push({
      type: 'last-prompt',
      leafUuid,
      sessionId,
    } as ClaudeEntry)
  }
  prefix.push({
    type: 'permission-mode',
    permissionMode: 'bypassPermissions',
    sessionId,
  } as ClaudeEntry)

  return [...prefix, ...conversation]
}
