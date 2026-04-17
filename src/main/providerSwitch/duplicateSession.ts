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

import {
  findCodexRolloutPathBySessionId,
  getClaudeSessionFilePath,
  readJsonlFile,
  writeClaudeSessionFile,
  writeCodexRolloutFile,
} from './shared.js'

export type DuplicateSessionRequest = {
  provider: 'claude' | 'codex'
  sourceProviderSessionId: string
  /** Required for Claude (session files are scoped to a cwd).
   *  Ignored for Codex — rollout files are discovered globally
   *  under `~/.codex/sessions`. */
  cwd: string
}

export type DuplicateSessionResult = {
  provider: 'claude' | 'codex'
  newProviderSessionId: string
  /** Absolute path to the newly-written transcript file. */
  newFilePath: string
}

export async function duplicateSession(
  request: DuplicateSessionRequest,
): Promise<DuplicateSessionResult> {
  if (request.provider === 'claude') {
    return duplicateClaude(request)
  }
  return duplicateCodex(request)
}

async function duplicateClaude(
  request: DuplicateSessionRequest,
): Promise<DuplicateSessionResult> {
  const sourceFilePath = await getClaudeSessionFilePath(
    request.cwd,
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
  const newFilePath = await writeClaudeSessionFile(request.cwd, entries)

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
  const newFilePath = await writeCodexRolloutFile(lines)

  return {
    provider: 'codex',
    newProviderSessionId: newSessionId,
    newFilePath,
  }
}
