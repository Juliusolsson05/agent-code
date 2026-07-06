import type { AgentProviderKind } from '@shared/types/providerKind.js'
// Duplicate an on-disk session into an independent, resumable copy.
//
// Produces a second transcript file that is a byte-for-byte clone
// of the source except for identity fields (session id, Codex
// timestamp). After duplication, `<provider> resume <newId>` spins
// up a fresh agent process against the clone without touching the
// original — both sessions continue as independent conversations
// from the same history baseline.
//
// Layering mirrors `switchProvider`: this file owns fs IO and
// orchestration; the per-format clone logic lives in the parser
// package (`cloneClaudeTranscript` / `cloneCodexRollout`).
//
// Codex SQLite note: codex-rs's resume flow (`find_thread_path_by_id_str`)
// queries the state DB first but falls back to a fs scan when the
// uuid isn't indexed, then self-repairs the DB with the discovered
// path. So dropping a new rollout-*.jsonl with a fresh uuid is
// enough — we don't touch SQLite directly, and the DB catches up
// on first resume.

import {
  cloneClaudeTranscript,
  cloneCodexRollout,
} from 'agent-transcript-parser'
import type {
  ClaudeEntry,
  CodexRolloutLine,
} from 'agent-transcript-parser'

import { sanitizeClaudeEntriesForResume } from '@main/providerSwitch/claudeResumeSanitizer.js'
import { sanitizeCodexRolloutForResume } from '@main/providerSwitch/codexResumeSanitizer.js'
import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  readJsonlFile,
  writeClaudeSessionFile,
  writeCodexRolloutFile,
} from '@main/providerSwitch/shared.js'

export type DuplicateSessionRequest = {
  provider: AgentProviderKind
  sourceProviderSessionId: string
  /** Required for Claude (session files are scoped to a cwd).
   *  Ignored for Codex — rollout files are discovered globally
   *  under `~/.codex/sessions`. */
  cwd: string
  /** Optional explicit source cwd for callers that need to read a Claude
   *  transcript from one project and write the clone for another. */
  sourceCwd?: string
  /** Optional explicit target cwd for Claude clone placement. Defaults to
   *  `cwd` for legacy callers. Ignored for Codex. */
  targetCwd?: string
}

export type DuplicateSessionResult = {
  provider: AgentProviderKind
  newProviderSessionId: string
  /** Absolute path to the newly-written transcript file. */
  newFilePath: string
}

export async function duplicateSession(
  request: DuplicateSessionRequest,
): Promise<DuplicateSessionResult> {
  // WHY explicit fail-loud dispatch instead of `if claude else codex`:
  //
  // Duplication is a file-format operation — the source transcript on disk has
  // a provider-specific shape (Claude JSONL sessions vs. Codex rollout lines)
  // and the clone must be written using the same shape. When OpenCode was
  // registered as a third `AgentProviderKind`, this function's original shape
  // `if (provider === 'claude') return duplicateClaude(...); return duplicateCodex(...)`
  // silently ran an OpenCode `Duplicate Agent` command through `duplicateCodex`
  // — reading OpenCode's server session id as if it were a Codex rollout id,
  // returning a nonsense "clone", and — worst-case — writing malformed data
  // over a real Codex rollout uuid collision. Refuse cleanly instead.
  //
  // This mirrors `switchProvider.ts` (see its throw for unknown pairs). When
  // OpenCode's on-disk model is understood well enough to duplicate it, add a
  // `duplicateOpencode` implementation and its branch here; until then the
  // Duplicate Agent command surface hides itself for OpenCode panes at the
  // `when` predicate level, and this throw is the last-mile safety net for
  // programmatic callers (MCP orchestration, tests) that bypass the palette.
  if (request.provider === 'claude') {
    return duplicateClaude(request)
  }
  if (request.provider === 'codex') {
    return duplicateCodex(request)
  }
  throw new Error(
    `duplicateSession: no duplicate implementation for provider "${request.provider}" yet`,
  )
}

async function duplicateClaude(
  request: DuplicateSessionRequest,
): Promise<DuplicateSessionResult> {
  const sourceCwd = request.sourceCwd ?? request.cwd
  const targetCwd = request.targetCwd ?? request.cwd
  const sourceFilePath = await getClaudeSessionFilePath(
    sourceCwd,
    request.sourceProviderSessionId,
  )
  // Read the whole source in a single shot. If the session is still
  // live and being appended to, we capture a consistent snapshot of
  // whatever was on disk at read time — later appends to the source
  // don't land in the clone (that's the duplicate's whole point).
  const sourceEntries = await readJsonlFile<ClaudeEntry>(sourceFilePath)
  if (sourceEntries.length === 0) {
    throw new Error(
      `Claude session ${request.sourceProviderSessionId} has no entries on disk.`,
    )
  }

  const { entries, newSessionId } = cloneClaudeTranscript(sourceEntries)
  const safeEntries = sanitizeClaudeEntriesForResume(entries)
  const newFilePath = await writeClaudeSessionFile(targetCwd, safeEntries)

  return {
    provider: 'claude',
    newProviderSessionId: newSessionId,
    newFilePath,
  }
}

async function duplicateCodex(
  request: DuplicateSessionRequest,
): Promise<DuplicateSessionResult> {
  const sourceFilePath = await findCodexRolloutPathBySessionId(
    request.sourceProviderSessionId,
  )
  if (!sourceFilePath) {
    throw new Error(
      `Codex rollout for session ${request.sourceProviderSessionId} was not found.`,
    )
  }
  const sourceLines = await readJsonlFile<CodexRolloutLine>(sourceFilePath)
  if (sourceLines.length === 0) {
    throw new Error(
      `Codex rollout ${sourceFilePath} is empty.`,
    )
  }

  const { lines, newSessionId } = cloneCodexRollout(sourceLines)
  const newFilePath = await writeCodexRolloutFile(
    sanitizeCodexRolloutForResume(lines),
  )

  return {
    provider: 'codex',
    newProviderSessionId: newSessionId,
    newFilePath,
  }
}
