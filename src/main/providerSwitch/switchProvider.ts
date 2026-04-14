import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'

import { toClaude, toCodex } from 'agent-transcript-parser'
import type { ClaudeEntry, CodexRolloutLine } from 'agent-transcript-parser'

import { getProjectDirForCwd } from '../../shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '../../providers/codex/runtime/projectDir.js'

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
  const translated = toCodex(sourceEntries, { lossy: false })
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

async function getClaudeSessionFilePath(
  cwd: string,
  providerSessionId: string,
): Promise<string> {
  const projectDir = await getProjectDirForCwd(cwd)
  return join(projectDir, `${providerSessionId}.jsonl`)
}

async function writeClaudeSessionFile(
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

async function writeCodexRolloutFile(
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

async function findCodexRolloutPathBySessionId(
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

async function walkCodexRollouts(
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

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, 'utf8')
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as T)
}

function encodeJsonl(items: readonly unknown[]): string {
  // These transcript files are append-oriented JSONL in both providers.
  // Writing them with a trailing newline keeps the result aligned with
  // native writers and avoids odd "last line has no newline" diffs when
  // debugging translated files by hand.
  return `${items.map(item => JSON.stringify(item)).join('\n')}\n`
}

function getClaudeSessionId(entries: readonly ClaudeEntry[]): string {
  const sessionId = entries.find(
    (entry): entry is ClaudeEntry & { sessionId: string } =>
      typeof entry.sessionId === 'string' && entry.sessionId.length > 0,
  )?.sessionId
  if (!sessionId) {
    throw new Error('Translated Claude transcript did not contain a sessionId.')
  }
  return sessionId
}

function getCodexSessionId(lines: readonly CodexRolloutLine[]): string {
  return getCodexSessionMeta(lines).payload.id
}

function getCodexSessionMeta(
  lines: readonly CodexRolloutLine[],
): Extract<CodexRolloutLine, { type: 'session_meta' }> {
  const line = lines.find(
    (candidate): candidate is Extract<CodexRolloutLine, { type: 'session_meta' }> =>
      candidate.type === 'session_meta' &&
      typeof candidate.payload.id === 'string' &&
      candidate.payload.id.length > 0,
  )
  if (!line) {
    throw new Error('Translated Codex rollout did not contain a valid session_meta line.')
  }
  return line
}

function resolveCodexRolloutTimestamp(raw: string): Date {
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed) : new Date()
}

function formatCodexRolloutTimestamp(date: Date): string {
  return [
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    `${pad2(date.getUTCHours())}-${pad2(date.getUTCMinutes())}-${pad2(date.getUTCSeconds())}`,
  ].join('T')
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
