// Pure data extractors for Codex wire shapes — NO JSX. See the header
// of providers/claude/renderer/extractors.ts for why this seam exists.

import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock } from '@shared/types/transcript'

export type ExecCommandInput = {
  command: string
  workdir: string | null
  yieldTimeMs: number | null
  maxOutputTokens: number | null
}

/** Parse an exec_command tool_use input. Codex passes the command as
 *  `cmd` (string OR pre-split argv array) or `command`; the metadata
 *  keys ride alongside. Canonical home — CodexRows.tsx imports this
 *  (it used to own a private copy). */
export function execCommandInput(input: unknown): ExecCommandInput | null {
  const rec = asRecord(input)
  if (!rec) return null
  const rawCommand = rec.cmd ?? rec.command
  const command = Array.isArray(rawCommand)
    ? rawCommand.map(String).join(' ')
    : typeof rawCommand === 'string'
      ? rawCommand
      : ''
  if (!command.trim()) return null
  return {
    command,
    workdir: typeof rec.workdir === 'string' ? rec.workdir : null,
    yieldTimeMs: typeof rec.yield_time_ms === 'number' ? rec.yield_time_ms : null,
    maxOutputTokens:
      typeof rec.max_output_tokens === 'number' ? rec.max_output_tokens : null,
  }
}

/** Codex exec metadata stamped on the tool_result block by the rollout
 *  mapper (codexToolResultEntry's `codex` extension — the source of
 *  truth is rollout.ts's exec_command_end branch). Claude has no
 *  equivalent; its results return nulls here. */
export function codexResultMeta(result: ToolResultBlock | null): {
  exitCode: number | null
  cwd: string | null
} {
  const meta = asRecord(result?.codex)
  if (!meta) return { exitCode: null, cwd: null }
  return {
    exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : null,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
  }
}
