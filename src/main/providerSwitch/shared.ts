// Shared fs + transcript helpers used by both switchProvider and
// duplicateSession.
//
// WHY split: the two features read/write the same transcript shapes
// (Claude per-cwd jsonl, Codex date-bucketed rollout), so helpers
// get duplicated if they live in feature files. Moving them here
// keeps each feature file focused on its own translation / cloning
// logic without re-implementing path math and jsonl IO.

import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import type { ClaudeEntry, CodexRolloutLine } from 'agent-transcript-parser'

import { getProjectDirForCwd } from '../../shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '../../providers/codex/runtime/projectDir.js'

// ---------------------------------------------------------------------------
// JSONL io
// ---------------------------------------------------------------------------

export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, 'utf8')
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as T)
}

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

export async function writeClaudeSessionFile(
  cwd: string,
  entries: readonly ClaudeEntry[],
): Promise<string> {
  const providerSessionId = getClaudeSessionId(entries)
  const projectDir = await getProjectDirForCwd(cwd)
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${providerSessionId}.jsonl`)
  await writeFile(filePath, encodeJsonl(entries), 'utf8')
  return filePath
}

export function getClaudeSessionId(entries: readonly ClaudeEntry[]): string {
  const sessionId = entries.find(
    (entry): entry is ClaudeEntry & { sessionId: string } =>
      typeof entry.sessionId === 'string' && entry.sessionId.length > 0,
  )?.sessionId
  if (!sessionId) {
    throw new Error('Claude transcript did not contain a sessionId.')
  }
  return sessionId
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

export async function writeCodexRolloutFile(
  lines: readonly CodexRolloutLine[],
): Promise<string> {
  const sessionMeta = getCodexSessionMeta(lines)
  const timestamp = resolveCodexRolloutTimestamp(sessionMeta.payload.timestamp)
  const sessionsDir = getCodexSessionsDir()
  const dayDir = join(
    sessionsDir,
    String(timestamp.getUTCFullYear()),
    pad2(timestamp.getUTCMonth() + 1),
    pad2(timestamp.getUTCDate()),
  )
  await mkdir(dayDir, { recursive: true })
  const filename = `rollout-${formatCodexRolloutTimestamp(timestamp)}-${sessionMeta.payload.id}.jsonl`
  const filePath = join(dayDir, filename)
  await writeFile(filePath, encodeJsonl(lines), 'utf8')
  return filePath
}

export function getCodexSessionId(lines: readonly CodexRolloutLine[]): string {
  return getCodexSessionMeta(lines).payload.id
}

export function getCodexSessionMeta(
  lines: readonly CodexRolloutLine[],
): Extract<CodexRolloutLine, { type: 'session_meta' }> {
  const line = lines.find(
    (candidate): candidate is Extract<CodexRolloutLine, { type: 'session_meta' }> =>
      candidate.type === 'session_meta' &&
      typeof candidate.payload.id === 'string' &&
      candidate.payload.id.length > 0,
  )
  if (!line) {
    throw new Error('Codex rollout did not contain a valid session_meta line.')
  }
  return line
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
