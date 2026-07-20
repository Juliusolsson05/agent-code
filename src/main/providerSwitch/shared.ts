import type { AgentProviderKind } from '@shared/types/providerKind.js'
// Shared fs + transcript helpers used by both switchProvider and
// duplicateSession.
//
// WHY split: the two features read/write the same transcript shapes
// (Claude per-cwd jsonl, Codex date-bucketed rollout), so helpers
// get duplicated if they live in feature files. Moving them here
// keeps each feature file focused on its own translation / cloning
// logic without re-implementing path math and jsonl IO.

import { mkdir, readdir, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import { getProjectDirForCwd } from '@shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '@providers/codex/runtime/projectDir.js'
import { getMainProvider } from '@providers/registry.main.js'

// ---------------------------------------------------------------------------
// JSONL io
// ---------------------------------------------------------------------------

export function encodeJsonl(items: readonly unknown[]): string {
  // Append-oriented JSONL in both providers — trailing newline keeps
  // the result aligned with native writers and avoids odd diffs when
  // debugging translated files by hand.
  return `${items.map(item => JSON.stringify(item)).join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Claude: per-cwd project dir, flat `<sessionId>.jsonl`
// ---------------------------------------------------------------------------

export async function getClaudeSessionFilePath(
  cwd: string,
  providerSessionId: string,
): Promise<string> {
  const projectDir = await getProjectDirForCwd(cwd)
  return join(projectDir, `${providerSessionId}.jsonl`)
}

export async function writeProjectedClaudeSessionFile(
  cwd: string,
  values: readonly Record<string, unknown>[],
): Promise<string> {
  const providerSessionId = projectedClaudeSessionId(values)
  const projectDir = await getProjectDirForCwd(cwd)
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${providerSessionId}.jsonl`)
  await writeFile(filePath, encodeJsonl(values), 'utf8')
  return filePath
}

// ---------------------------------------------------------------------------
// Codex: date-bucketed `<year>/<month>/<day>/rollout-<ts>-<uuid>.jsonl`
// ---------------------------------------------------------------------------

export async function findCodexRolloutPathBySessionId(
  providerSessionId: string,
): Promise<string | null> {
  const sessionsDir = getCodexSessionsDir()
  const matches: Array<{ path: string; mtimeMs: number }> = []
  await walkCodexRollouts(sessionsDir, async filePath => {
    if (!filePath.endsWith(`-${providerSessionId}.jsonl`)) return
    try {
      const fileStat = await stat(filePath)
      matches.push({ path: filePath, mtimeMs: fileStat.mtimeMs })
    } catch {
      // Ignore files that disappeared mid-scan.
    }
  })
  if (matches.length === 0) return null
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches[0]?.path ?? null
}

export async function resolveProviderTranscriptPath(params: {
  kind: AgentProviderKind
  cwd: string
  providerSessionId: string
}): Promise<string | null> {
  // WHY this helper lives beside provider-switch cloning helpers instead of in
  // one caller: transcript ownership is a provider storage contract. History
  // pagination, transcript-template resolution, duplicate/rewind flows, and
  // provider switching must agree on the exact same path semantics or the UI can
  // resume one durable file while older-history pagination reads another. The
  // provider registry owns those semantics now: Claude resolves a cwd-scoped
  // JSONL path, while Codex resolves a global rollout file by structured thread
  // id. Delegating here lets history loading, transcript templates, and provider
  // templates share one call site without moving provider-specific storage rules
  // back into each feature. Provider-switch/duplicate/rewind still use the
  // Codex-specific helper above when they need the source path directly, and
  // that helper intentionally uses the same mtime tie-break as the registry.
  return getMainProvider(params.kind).resolveTranscriptPath(
    params.cwd,
    params.providerSessionId,
  )
}

export async function walkCodexRollouts(
  dir: string,
  onFile: (filePath: string) => Promise<void>,
  depth = 0,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const fullPath = join(dir, name)
    try {
      const fileStat = await stat(fullPath)
      if (fileStat.isDirectory() && depth < 3) {
        await walkCodexRollouts(fullPath, onFile, depth + 1)
        continue
      }
      if (fileStat.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        await onFile(fullPath)
      }
    } catch {
      // Ignore unreadable entries while scanning the sessions tree.
    }
  }
}

export async function writeProjectedCodexRolloutFile(
  values: readonly Record<string, unknown>[],
): Promise<string> {
  const sessionMeta = projectedCodexSessionMeta(values)
  const timestamp = resolveCodexRolloutTimestamp(sessionMeta.timestamp)
  const sessionsDir = getCodexSessionsDir()
  const dayDir = join(
    sessionsDir,
    String(timestamp.getUTCFullYear()),
    pad2(timestamp.getUTCMonth() + 1),
    pad2(timestamp.getUTCDate()),
  )
  await mkdir(dayDir, { recursive: true })
  const filename = `rollout-${formatCodexRolloutTimestamp(timestamp)}-${sessionMeta.id}.jsonl`
  const filePath = join(dayDir, filename)
  await writeFile(filePath, encodeJsonl(values), 'utf8')
  return filePath
}

export function projectedClaudeSessionId(values: readonly Record<string, unknown>[]): string {
  const sessionId = values.find(value => (
    typeof value.sessionId === 'string' && value.sessionId.length > 0
  ))?.sessionId
  if (typeof sessionId !== 'string') {
    throw new Error('Projected Claude transcript did not contain a sessionId.')
  }
  return sessionId
}

export function projectedCodexSessionMeta(
  values: readonly Record<string, unknown>[],
): { id: string; timestamp: string } {
  for (const value of values) {
    if (value.type !== 'session_meta' || !isRecord(value.payload)) continue
    if (typeof value.payload.id !== 'string' || typeof value.payload.timestamp !== 'string') continue
    return { id: value.payload.id, timestamp: value.payload.timestamp }
  }
  throw new Error('Projected Codex rollout did not contain valid session metadata.')
}

export function resolveCodexRolloutTimestamp(raw: string): Date {
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed) : new Date()
}

export function formatCodexRolloutTimestamp(date: Date): string {
  return [
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    `${pad2(date.getUTCHours())}-${pad2(date.getUTCMinutes())}-${pad2(date.getUTCSeconds())}`,
  ].join('T')
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
