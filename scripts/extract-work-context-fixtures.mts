#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Existing provider/workspace recordings -> public work-context fixtures.
//
// WHY this is an extractor, not another recorder: Codex, Claude, and Agent Code
// already persist the authoritative streams that reproduced #658/#659. Adding a
// second runtime collection path would create another source that can drift from
// the bug. This script only selects, minimizes, redacts, and verifies records the
// existing systems already wrote. See
// docs/decomposition/worktree-context-and-dispatch-labels.md, Stage 1.
//
// Usage:
//   TSX_TSCONFIG_PATH=tsconfig.web.json npx tsx scripts/extract-work-context-fixtures.mts
//   # Explicitly replace the checked-in Dispatch snapshot from live state:
//   ... scripts/extract-work-context-fixtures.mts --refresh-workspace

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  findSensitiveSurvivors,
  redactRecording,
} from '../src/renderer/src/rendering/replay/redact.js'
import { buildVisibleDispatchRows } from '../src/renderer/src/workspace/dispatch/dispatchSelectors.js'
import { paneLabelForSession } from '../src/renderer/src/workspace/tile-tree/paneLabels.js'
import type { WorkspaceState } from '../src/renderer/src/workspace/types.js'

type JsonRecord = Record<string, unknown>

const HOME = homedir()
const REPO = resolve(import.meta.dirname, '..')
const CODEX_ROOT = join(HOME, '.codex', 'sessions')
const CLAUDE_ROOT = join(HOME, '.claude', 'projects')
const WORKSPACE_FILE = join(HOME, '.config', 'agent-code', 'workspace.json')
const FIXTURE_DIR = join(REPO, 'testing', 'fixtures', 'worktree-context')
const DISPATCH_FIXTURE_FILE = join(FIXTURE_DIR, 'dispatch-global-d23.json')
const EVIDENCE_DIR = join(
  REPO,
  'docs',
  'decomposition',
  'evidence',
  'worktree-context',
)

// WHY the census has a fixed upper bound: this extraction is itself running
// inside Codex, so every verification command appends more rollout records.
// Counting "whatever exists when the last command finishes" makes the artifact
// non-reproducible by construction. The approved decomposition recorded this
// cutoff before Stage 1; records at or before it are immutable provider facts.
const CUTOFF = '2026-08-26T21:38:22.000Z'
const CURRENT_DAY = '2026-08-26'
const REFRESH_WORKSPACE = process.argv.includes('--refresh-workspace')

// One real rollout starts in the main checkout and later writes into the
// focus-mode worktree. These stable timestamps select the same records even as
// that JSONL grows. The order is provider order, not an order invented here.
const CODEX_TRANSITION_TIMESTAMPS = [
  '2026-08-26T20:51:40.603Z', // session_meta cwd: main checkout
  '2026-08-26T20:51:41.198Z', // turn_context cwd: main checkout
  '2026-08-26T20:51:45.771Z', // completed command cwd: file:// main checkout
  '2026-08-26T20:54:01.907Z', // thread_settings_applied cwd: main checkout
  '2026-08-26T21:06:14.436Z', // two-file FileChange inside linked worktree
  '2026-08-26T21:10:28.439Z', // next turn_context still reports launch cwd
] as const

// Real negative control: an orchestration call's cwd names the CHILD checkout,
// not the current agent's cwd. A recursive "find every cwd" parser fails here.
const CODEX_MCP_NEGATIVE_TIMESTAMP = '2026-08-26T21:03:44.673Z'

type SelectedRecord = {
  file: string
  line: number
  record: JsonRecord
}

type CodexCensus = {
  filesWithRelevantRecords: Set<string>
  recordsMissingTimestamp: number
  sessionMeta: number
  sessionMetaBranch: number
  sessionMetaNoBranch: number
  turnContext: number
  turnWorkspaceRootsArray: number
  turnWorkspaceRootsMissing: number
  threadSettingsApplied: number
  commandExecution: number
  commandCwdFileUrl: number
  commandCwdFileUrlWithHost: number
  commandCwdFileUrlPercentEncoded: number
  commandCwdFileUrlMalformed: number
  commandCwdAbsolute: number
  commandCwdOther: number
  commandShapeArray: number
  commandShapeString: number
  commandExecutionStatuses: Map<string, number>
  fileChange: number
  fileChangeObject: number
  fileChangeOther: number
  fileChangeStatuses: Map<string, number>
  fileChangePaths: number
  fileChangeMaxPaths: number
  fileChangeAbsolutePaths: number
  fileChangeFileUrls: number
  fileChangeRelativePaths: number
  fileChangePathsWithRecognizedRoot: number
  fileChangePathsWithoutRecognizedRoot: number
  fileChangeMultipleRoots: number
  mcpToolCall: number
  mcpToolCallWithCwd: number
  completedItemTypes: Map<string, number>
  legacyExecCommandEnd: number
  legacyExecApprovalRequest: number
  legacyLocalShellCall: number
  legacyFunctionCall: number
}

function emptyCodexCensus(): CodexCensus {
  return {
    filesWithRelevantRecords: new Set(),
    recordsMissingTimestamp: 0,
    sessionMeta: 0,
    sessionMetaBranch: 0,
    sessionMetaNoBranch: 0,
    turnContext: 0,
    turnWorkspaceRootsArray: 0,
    turnWorkspaceRootsMissing: 0,
    threadSettingsApplied: 0,
    commandExecution: 0,
    commandCwdFileUrl: 0,
    commandCwdFileUrlWithHost: 0,
    commandCwdFileUrlPercentEncoded: 0,
    commandCwdFileUrlMalformed: 0,
    commandCwdAbsolute: 0,
    commandCwdOther: 0,
    commandShapeArray: 0,
    commandShapeString: 0,
    commandExecutionStatuses: new Map(),
    fileChange: 0,
    fileChangeObject: 0,
    fileChangeOther: 0,
    fileChangeStatuses: new Map(),
    fileChangePaths: 0,
    fileChangeMaxPaths: 0,
    fileChangeAbsolutePaths: 0,
    fileChangeFileUrls: 0,
    fileChangeRelativePaths: 0,
    fileChangePathsWithRecognizedRoot: 0,
    fileChangePathsWithoutRecognizedRoot: 0,
    fileChangeMultipleRoots: 0,
    mcpToolCall: 0,
    mcpToolCallWithCwd: 0,
    completedItemTypes: new Map(),
    legacyExecCommandEnd: 0,
    legacyExecApprovalRequest: 0,
    legacyLocalShellCall: 0,
    legacyFunctionCall: 0,
  }
}

type ClaudeCensus = {
  filesWithRelevantRecords: Set<string>
  worktreeEnter: number
  worktreeExit: number
  worktreeEnterWithBranch: number
  worktreeEnterFromBackup: number
  worktreeEnterFromCurrentCorpus: number
  firstConversationAtWorktree: number
  firstConversationAtOriginalCwd: number
  firstConversationAtOtherCwd: number
  worktreeEnterWithoutFollowingConversation: number
  conversationWithCwd: number
  conversationWithCwdAndBranch: number
  agentCodeConversationWithCwd: number
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function stringField(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(root)
  return files
}

async function forEachJsonlRecord(
  file: string,
  visit: (record: JsonRecord, line: number) => void,
): Promise<void> {
  const input = createReadStream(file)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let line = 0
  for await (const text of lines) {
    line += 1
    if (!text) continue
    try {
      const record = asRecord(JSON.parse(text))
      if (record) visit(record, line)
    } catch {
      // Torn provider lines are normal while a process is appending. The raw
      // transcript parser already skips them; a census must follow the same
      // rule or the measurement and production source population diverge.
    }
  }
}

function recordIncluded(record: JsonRecord): boolean {
  const timestamp = stringField(record, 'timestamp')
  if (!timestamp) return true
  return timestamp <= CUTOFF
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function cwdScheme(value: unknown): 'file-url' | 'absolute' | 'other' {
  if (typeof value !== 'string') return 'other'
  if (value.startsWith('file://')) return 'file-url'
  if (value.startsWith('/')) return 'absolute'
  return 'other'
}

function filesystemPath(value: string): string {
  if (!value.startsWith('file:')) return value
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value
  }
}

function recordedRoot(value: string): string | null {
  const path = filesystemPath(value)
  const worktree = path.match(/^(.*?\/\.worktrees\/[^/]+)/)
  if (worktree?.[1]) return worktree[1]
  const development = path.match(/^(.*?\/Desktop\/Development\/[^/]+)/)
  return development?.[1] ?? null
}

function observeCodex(
  census: CodexCensus,
  file: string,
  record: JsonRecord,
): void {
  if (!recordIncluded(record)) return
  const timestamp = stringField(record, 'timestamp')

  const payload = asRecord(record.payload)
  let relevant = false
  if (record.type === 'session_meta' && payload) {
    relevant = true
    census.sessionMeta += 1
    const git = asRecord(payload.git)
    if (stringField(git, 'branch')) census.sessionMetaBranch += 1
    else census.sessionMetaNoBranch += 1
  } else if (record.type === 'turn_context' && payload) {
    relevant = true
    census.turnContext += 1
    if (Array.isArray(payload.workspace_roots)) census.turnWorkspaceRootsArray += 1
    else census.turnWorkspaceRootsMissing += 1
  } else if (record.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
    relevant = true
    census.threadSettingsApplied += 1
  } else if (record.type === 'event_msg' && payload?.type === 'item_completed') {
    const item = asRecord(payload.item)
    const itemType = stringField(item, 'type')
    if (itemType) increment(census.completedItemTypes, itemType)
    if (itemType === 'CommandExecution') {
      relevant = true
      census.commandExecution += 1
      increment(
        census.commandExecutionStatuses,
        stringField(item, 'status') ?? 'missing',
      )
      const scheme = cwdScheme(item?.cwd)
      if (scheme === 'file-url') {
        census.commandCwdFileUrl += 1
        const cwd = item?.cwd as string
        if (/%[0-9a-f]{2}/i.test(cwd)) census.commandCwdFileUrlPercentEncoded += 1
        try {
          if (new URL(cwd).host.length > 0) census.commandCwdFileUrlWithHost += 1
        } catch {
          census.commandCwdFileUrlMalformed += 1
        }
      }
      else if (scheme === 'absolute') census.commandCwdAbsolute += 1
      else census.commandCwdOther += 1
      if (Array.isArray(item?.command)) census.commandShapeArray += 1
      else if (typeof item?.command === 'string') census.commandShapeString += 1
    } else if (itemType === 'FileChange') {
      relevant = true
      census.fileChange += 1
      increment(
        census.fileChangeStatuses,
        stringField(item, 'status') ?? 'missing',
      )
      const changes = asRecord(item?.changes)
      if (changes) {
        census.fileChangeObject += 1
        const paths = Object.keys(changes)
        census.fileChangePaths += paths.length
        census.fileChangeMaxPaths = Math.max(census.fileChangeMaxPaths, paths.length)
        const roots = new Set<string>()
        for (const path of paths) {
          const scheme = cwdScheme(path)
          if (scheme === 'file-url') census.fileChangeFileUrls += 1
          else if (scheme === 'absolute') census.fileChangeAbsolutePaths += 1
          else census.fileChangeRelativePaths += 1
          const root = recordedRoot(path)
          if (root) {
            census.fileChangePathsWithRecognizedRoot += 1
            roots.add(root)
          } else {
            census.fileChangePathsWithoutRecognizedRoot += 1
          }
        }
        if (roots.size > 1) census.fileChangeMultipleRoots += 1
      } else {
        census.fileChangeOther += 1
      }
    } else if (itemType === 'McpToolCall') {
      relevant = true
      census.mcpToolCall += 1
      if (stringField(asRecord(item?.arguments), 'cwd')) census.mcpToolCallWithCwd += 1
    }
  }

  if (record.type === 'event_msg' && payload?.type === 'exec_command_end') {
    relevant = true
    census.legacyExecCommandEnd += 1
  }
  if (record.type === 'event_msg' && payload?.type === 'exec_approval_request') {
    relevant = true
    census.legacyExecApprovalRequest += 1
  }
  if (record.type === 'response_item' && payload?.type === 'local_shell_call') {
    relevant = true
    census.legacyLocalShellCall += 1
  }
  if (record.type === 'response_item' && payload?.type === 'function_call') {
    relevant = true
    census.legacyFunctionCall += 1
  }

  if (relevant) {
    census.filesWithRelevantRecords.add(file)
    if (!timestamp) census.recordsMissingTimestamp += 1
  }
}

function selectRecord(
  selected: Map<string, SelectedRecord>,
  file: string,
  line: number,
  record: JsonRecord,
): void {
  const timestamp = stringField(record, 'timestamp')
  if (!timestamp) return
  if (
    !CODEX_TRANSITION_TIMESTAMPS.includes(
      timestamp as typeof CODEX_TRANSITION_TIMESTAMPS[number],
    ) &&
    timestamp !== CODEX_MCP_NEGATIVE_TIMESTAMP
  ) return
  if (selected.has(timestamp)) {
    throw new Error(`record timestamp ${timestamp} is not unique in Codex corpus`)
  }
  selected.set(timestamp, { file, line, record })
}

function projectedCodexRecord(record: JsonRecord): JsonRecord {
  const payload = asRecord(record.payload)
  if (!payload) throw new Error('selected Codex record has no payload object')
  const base: JsonRecord = {
    type: record.type,
    timestamp: record.timestamp,
  }

  if (record.type === 'session_meta') {
    const git = asRecord(payload.git)
    base.payload = {
      cwd: payload.cwd,
      cli_version: payload.cli_version,
      git: git ? { branch: git.branch } : null,
    }
    return base
  }
  if (record.type === 'turn_context') {
    base.payload = {
      cwd: payload.cwd,
      workspace_roots: payload.workspace_roots,
    }
    return base
  }
  if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    const settings = asRecord(payload.thread_settings)
    base.payload = {
      type: payload.type,
      thread_settings: settings ? { cwd: settings.cwd } : null,
    }
    return base
  }
  if (record.type === 'event_msg' && payload.type === 'item_completed') {
    const item = asRecord(payload.item)
    if (!item) throw new Error('selected item_completed record has no item')
    const projectedItem: JsonRecord = { type: item.type }
    for (const key of [
      'command',
      'cwd',
      'changes',
      'status',
      'tool',
      'arguments',
    ]) {
      if (hasOwn(item, key)) projectedItem[key] = item[key]
    }
    if (item.type === 'McpToolCall') {
      const argumentsRecord = asRecord(item.arguments)
      projectedItem.arguments = argumentsRecord && hasOwn(argumentsRecord, 'cwd')
        ? { cwd: argumentsRecord.cwd }
        : {}
    }
    base.payload = { type: payload.type, item: projectedItem }
    return base
  }
  throw new Error(`selected unsupported Codex record ${String(record.type)}`)
}

const identityTokens = new Map<string, string>()
const branchTokens = new Map<string, string>()
const worktreeTokens = new Map<string, string>()
const projectTokens = new Map<string, string>()
const pathSegmentTokens = new Map<string, string>()

function resetRecordedTokens(): void {
  // WHY each fixture gets its own token namespace: an unrelated new workspace
  // tab must not renumber an immutable Codex rollout from project-1 to
  // project-2. Cross-fixture identity has no semantic value, while local token
  // stability is required for reproducible fixture review.
  identityTokens.clear()
  branchTokens.clear()
  worktreeTokens.clear()
  projectTokens.clear()
  pathSegmentTokens.clear()
}

function tokenFor(map: Map<string, string>, value: string, prefix: string): string {
  const existing = map.get(value)
  if (existing) return existing
  const token = `${prefix}-${map.size + 1}`
  map.set(value, token)
  return token
}

function tokenizePathTail(parts: string[]): string[] {
  // WHY tokenize every non-structural segment: replacing only the home prefix
  // still publishes private directory names, while work-context tests need
  // only path identity and the `.worktrees/<name>` topology. Keeping this
  // helper outside the per-path hot loop also avoids allocating a closure for
  // every recorded cwd and changed file.
  const tokenized: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === '.worktrees' && parts[index + 1]) {
      tokenized.push('.worktrees')
      tokenized.push(tokenFor(
        worktreeTokens,
        parts[index + 1]!,
        'worktree',
      ))
      index += 1
      continue
    }
    if (part) tokenized.push(tokenFor(pathSegmentTokens, part, 'path'))
  }
  return tokenized
}

function tokenizeFilesystemPath(path: string): string {
  const normalized = path.replace(/\/+$/, '') || '/'
  const developmentPrefix = join(HOME, 'Desktop', 'Development')

  if (normalized === developmentPrefix || normalized.startsWith(`${developmentPrefix}/`)) {
    const remainder = normalized.slice(developmentPrefix.length).replace(/^\/+/, '')
    const [project, ...parts] = remainder.split('/')
    if (!project) return '/fixture/development'
    const projectToken = tokenFor(projectTokens, project, 'project')
    const tail = tokenizePathTail(parts)
    return `/fixture/${projectToken}${tail.length > 0 ? `/${tail.join('/')}` : ''}`
  }
  if (normalized === HOME || normalized.startsWith(`${HOME}/`)) {
    const parts = normalized.slice(HOME.length).split('/').filter(Boolean)
    const tail = tokenizePathTail(parts)
    return `/fixture/home${tail.length > 0 ? `/${tail.join('/')}` : ''}`
  }
  if (normalized.startsWith('/')) {
    const tail = tokenizePathTail(normalized.split('/').filter(Boolean))
    return `/fixture/external${tail.length > 0 ? `/${tail.join('/')}` : ''}`
  }
  return tokenFor(pathSegmentTokens, normalized, 'path')
}

function tokenizePath(value: string): string {
  if (!value.startsWith('file:')) return tokenizeFilesystemPath(value)
  try {
    const url = new URL(value)
    const path = tokenizeFilesystemPath(decodeURIComponent(url.pathname))
    return `file://${path}`
  } catch {
    return 'file:///fixture/invalid-url'
  }
}

const PATH_KEYS = new Set([
  'cwd',
  'path',
  'file_path',
  'worktreePath',
  'originalCwd',
  'workspace_roots',
])
const IDENTITY_KEYS = new Set([
  'id',
  'uuid',
  'parentUuid',
  'sessionId',
  'providerSessionId',
  'itemId',
  'callId',
  'tool_use_id',
  'toolUseId',
])

function restoreRecordedStructure(
  raw: unknown,
  redacted: unknown,
  key?: string,
): unknown {
  if (typeof raw === 'string') {
    if (key && PATH_KEYS.has(key)) return tokenizePath(raw)
    if (key && IDENTITY_KEYS.has(key)) {
      return tokenFor(identityTokens, raw, 'fixture-id')
    }
    if (key && /branch$/i.test(key)) {
      return `fixture/${tokenFor(branchTokens, raw, 'branch')}`
    }
    if (key === 'cli_version' && /^\d+\.\d+\.\d+$/.test(raw)) return raw
    if (key === 'tool' && /^[a-z0-9_:.-]+$/i.test(raw)) return raw
    return redacted
  }
  if (Array.isArray(raw)) {
    const redactedArray = Array.isArray(redacted) ? redacted : []
    return raw.map((value, index) => restoreRecordedStructure(
      value,
      redactedArray[index],
      key,
    ))
  }
  const rawRecord = asRecord(raw)
  const redactedRecord = asRecord(redacted)
  if (!rawRecord || !redactedRecord) return redacted

  if (key === 'changes') {
    const changes: JsonRecord = {}
    for (const [path, value] of Object.entries(rawRecord)) {
      changes[tokenizePath(path)] = restoreRecordedStructure(
        value,
        redactedRecord[path],
      )
    }
    return changes
  }

  const result: JsonRecord = {}
  for (const [childKey, value] of Object.entries(rawRecord)) {
    if (!hasOwn(redactedRecord, childKey)) continue
    result[childKey] = restoreRecordedStructure(
      value,
      redactedRecord[childKey],
      childKey,
    )
  }
  return result
}

function redactProviderRecord(projected: JsonRecord): JsonRecord {
  // WHY reuse the canonical structure-only redactor first: it already owns the
  // sensitive-key vocabulary and free-text policy used by checked-in recording
  // fixtures. The second pass restores only the few path/branch/identity shapes
  // this work-context fixture exists to exercise, and restores them as tokens.
  const recording = redactRecording({
    meta: { kind: 'work-context-fixture' },
    events: [{ t: 0, wall: 0, ch: 'provider-jsonl', payload: projected }],
  }, 'structure-only')
  const payload = recording.events[0]?.payload
  const restored = restoreRecordedStructure(projected, payload)
  const result = asRecord(restored)
  if (!result) throw new Error('provider fixture redaction lost record object')
  return result
}

function projectClaudeRecord(record: JsonRecord): JsonRecord {
  if (record.type === 'worktree-state') {
    return {
      type: record.type,
      sessionId: record.sessionId,
      worktreeSession: record.worktreeSession,
    }
  }
  const message = asRecord(record.message)
  if ((record.type === 'assistant' || record.type === 'user') && message) {
    return {
      type: record.type,
      uuid: record.uuid,
      parentUuid: record.parentUuid,
      timestamp: record.timestamp,
      sessionId: record.sessionId,
      cwd: record.cwd,
      gitBranch: record.gitBranch,
      message: {
        role: message.role,
        content: message.content,
      },
    }
  }
  throw new Error(`selected unsupported Claude record ${String(record.type)}`)
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
const STRUCTURAL_FIXTURE_PATH =
  /^(?:file:\/\/)?\/fixture\/(?:development|invalid-url|project-\d+|home|external)(?:\/path-\d+)*(?:\/\.worktrees\/worktree-\d+(?:\/path-\d+)*)?$/
const ALLOWED_FIXTURE_STRINGS = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'thread_settings_applied',
  'item_completed',
  'CommandExecution',
  'FileChange',
  'McpToolCall',
  'orchestration_create_agent',
  'worktree-state',
  'assistant',
  'user',
  'text',
  'completed',
  'add',
  'update',
  'delete',
  'claude',
  'codex',
  'opencode',
  'terminal',
  'dispatch',
  'grid',
  'detached',
  'global',
  'project',
  'leaf',
  'split',
  'vertical',
  'horizontal',
])

function fixtureStringAllowed(value: string): boolean {
  return ALLOWED_FIXTURE_STRINGS.has(value) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    /^\d+\.\d+\.\d+$/.test(value) ||
    STRUCTURAL_FIXTURE_PATH.test(value) ||
    /^fixture\/(?:branch)-\d+$/.test(value) ||
    /^(?:fixture-id|tab|session|project|agent|worktree)-\d+$/.test(value) ||
    /^⟨(?:text:\d+|redacted)⟩$/.test(value)
}

function assertPublishablePayload(payload: unknown, label: string): void {
  const sensitive = findSensitiveSurvivors(payload)
  if (sensitive.length > 0) {
    throw new Error(
      `refusing to emit ${label}: sensitive-key values survived at ${sensitive.join(', ')}`,
    )
  }
  const serialized = JSON.stringify(payload)
  const username = HOME.split('/').filter(Boolean).at(-1) ?? ''
  if (serialized.includes(HOME) || (username.length >= 3 && serialized.includes(username))) {
    throw new Error(`refusing to emit ${label}: operator home/username survived`)
  }
  if (UUID.test(serialized)) {
    throw new Error(`refusing to emit ${label}: UUID-shaped identity survived`)
  }

  const rejected: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!fixtureStringAllowed(value)) rejected.push(`${path}=${value.slice(0, 80)}`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`))
      return
    }
    const record = asRecord(value)
    if (!record) return
    for (const [key, child] of Object.entries(record)) {
      walk(child, path ? `${path}.${key}` : key)
    }
  }
  walk(payload, '')
  if (rejected.length > 0) {
    throw new Error(
      `refusing to emit ${label}: non-allowlisted strings survived\n${rejected.slice(0, 12).join('\n')}`,
    )
  }
}

function sourceFingerprint(records: readonly SelectedRecord[]): string {
  const hash = createHash('sha256')
  for (const selected of records) hash.update(JSON.stringify(selected.record))
  return hash.digest('hex').slice(0, 16)
}

function sourceRefs(
  records: readonly SelectedRecord[],
): Array<{ timestamp: string | null; line: number }> {
  return records.map(record => ({
    timestamp: stringField(record.record, 'timestamp'),
    line: record.line,
  }))
}

function requiredSelectedRecord(
  value: SelectedRecord | null,
  label: string,
): SelectedRecord {
  if (!value) throw new Error(`required recorded ${label} fixture not found`)
  return value
}

function sessionIdMapper(): (value: unknown) => string | undefined {
  const ids = new Map<string, string>()
  return (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return undefined
    return tokenFor(ids, value, 'session')
  }
}

type DispatchObservation = {
  tabCount: number
  visibleRowCount: number
  mismatchCount: number
  targetSessionId: string
  targetVisibleLabel: string
  targetLocalLabel: string | null
  targetPlacement: string
}

function replayDispatchState(state: WorkspaceState): {
  state: WorkspaceState
  observed: DispatchObservation
} {
  const rows = buildVisibleDispatchRows(state)
  const target = rows.find(row => row.label === 'D23')
  if (!target) throw new Error('recorded workspace no longer contains D23')
  const local = paneLabelForSession(state, target.tabId, target.sessionId)
  if (local === target.label) {
    throw new Error('recorded D23 no longer reproduces Dispatch/local divergence')
  }
  const mismatches = rows.filter(row => (
    paneLabelForSession(state, row.tabId, row.sessionId) !== row.label
  ))
  return {
    state,
    observed: {
      tabCount: state.tabs.length,
      visibleRowCount: rows.length,
      mismatchCount: mismatches.length,
      targetSessionId: target.sessionId,
      targetVisibleLabel: target.label,
      targetLocalLabel: local,
      targetPlacement: target.placement,
    },
  }
}

function reducedDispatchState(raw: JsonRecord): {
  state: WorkspaceState
  observed: DispatchObservation
} {
  const persisted = asRecord(raw.workspace)
  if (!persisted) throw new Error('workspace.json has no workspace object')
  const sourceState = {
    ...persisted,
    pinnedSessionIds: Array.isArray(persisted.pinnedSessionIds)
      ? persisted.pinnedSessionIds
      : [],
  } as unknown as WorkspaceState
  const sourceRows = buildVisibleDispatchRows(sourceState)
  const sourceTarget = sourceRows.find(row => row.label === 'D23')
  if (!sourceTarget) throw new Error('recorded workspace no longer contains D23')
  const sourceLocal = paneLabelForSession(
    sourceState,
    sourceTarget.tabId,
    sourceTarget.sessionId,
  )
  if (sourceLocal === sourceTarget.label) {
    throw new Error('recorded D23 no longer reproduces Dispatch/local divergence')
  }

  const tabs = Array.isArray(persisted.tabs) ? persisted.tabs : []
  const tabIds = new Map<string, string>()
  tabs.forEach((tab, index) => {
    const id = stringField(asRecord(tab), 'id')
    if (id) tabIds.set(id, `tab-${index + 1}`)
  })
  const mapSessionId = sessionIdMapper()
  sourceRows.forEach(row => mapSessionId(row.sessionId))
  const sourceSessions = asRecord(persisted.sessions) ?? {}
  Object.keys(sourceSessions).forEach(mapSessionId)

  const reduceNode = (value: unknown): unknown => {
    const node = asRecord(value)
    if (!node) return value
    if (node.type === 'leaf') {
      return { type: 'leaf', sessionId: mapSessionId(node.sessionId) }
    }
    return {
      type: node.type,
      direction: node.direction,
      ratio: node.ratio,
      a: reduceNode(node.a),
      b: reduceNode(node.b),
    }
  }

  const reducedTabs = tabs.map((tabValue, index) => {
    const tab = asRecord(tabValue) ?? {}
    return {
      id: tabIds.get(String(tab.id)),
      title: `project-${index + 1}`,
      root: reduceNode(tab.root),
      focusedSessionId: mapSessionId(tab.focusedSessionId) ?? null,
    }
  })

  const reducedSessions: JsonRecord = {}
  let titleIndex = 0
  for (const [sourceId, value] of Object.entries(sourceSessions)) {
    const meta = asRecord(value)
    const sessionId = mapSessionId(sourceId)
    if (!meta || !sessionId) continue
    titleIndex += 1
    reducedSessions[sessionId] = {
      cwd: typeof meta.cwd === 'string' ? tokenizePath(meta.cwd) : '/fixture/project-1',
      kind: meta.kind,
      ...(typeof meta.title === 'string' && { title: `agent-${titleIndex}` }),
      ...(mapSessionId(meta.linkedParentId) && {
        linkedParentId: mapSessionId(meta.linkedParentId),
      }),
      ...(mapSessionId(meta.orchestrationParentId) && {
        orchestrationParentId: mapSessionId(meta.orchestrationParentId),
      }),
    }
  }

  const sourceDetached = asRecord(persisted.detachedSessions) ?? {}
  const reducedDetached: JsonRecord = {}
  const detachedAtRanks = new Map(
    [...new Set(Object.values(sourceDetached)
      .map(value => asRecord(value)?.detachedAt)
      .filter((value): value is number => (
        typeof value === 'number' && Number.isFinite(value)
      )))]
      .sort((left, right) => left - right)
      .map((value, index) => [value, index + 1]),
  )
  for (const [sourceId, value] of Object.entries(sourceDetached)) {
    const detached = asRecord(value)
    const sessionId = mapSessionId(sourceId)
    if (!detached || !sessionId) continue
    const projectTabId = typeof detached.projectTabId === 'string'
      ? tabIds.get(detached.projectTabId)
      : undefined
    const detachedAt = typeof detached.detachedAt === 'number'
      ? detachedAtRanks.get(detached.detachedAt)
      : undefined
    if (!detachedAt) {
      throw new Error('recorded detached session has no finite ordering value')
    }
    reducedDetached[sessionId] = {
      sessionId,
      surface: detached.surface,
      projectTabId,
      projectTabTitle: projectTabId,
      projectTabIndex: detached.projectTabIndex,
      // WHY keep only rank, not the wall clock: Dispatch ordering needs the
      // relative detach sequence, while the operator's real usage timestamps
      // are neither behaviorally relevant nor appropriate public fixture data.
      detachedAt,
    }
  }

  const dispatch = asRecord(persisted.dispatchMode)
  const tiled = asRecord(dispatch?.tiled)
  const reducedDispatch = dispatch ? {
    scope: dispatch.scope,
    focusedSessionId: mapSessionId(dispatch.focusedSessionId),
    ...(tiled && {
      tiled: {
        focusedLane: tiled.focusedLane,
        ratios: tiled.ratios,
        lanes: Array.isArray(tiled.lanes)
          ? tiled.lanes.map(laneValue => {
              const lane = asRecord(laneValue)
              const selectedSessionId = mapSessionId(lane?.selectedSessionId)
              return selectedSessionId ? { selectedSessionId } : {}
            })
          : [],
      },
    }),
  } : null

  const state = {
    tabs: reducedTabs,
    activeTabId: typeof persisted.activeTabId === 'string'
      ? tabIds.get(persisted.activeTabId) ?? reducedTabs[0]?.id
      : reducedTabs[0]?.id,
    dispatchMode: reducedDispatch,
    sessions: reducedSessions,
    detachedSessions: reducedDetached,
    buried: [],
    pinnedSessionIds: Array.isArray(persisted.pinnedSessionIds)
      ? persisted.pinnedSessionIds
          .map(mapSessionId)
          .filter((value): value is string => Boolean(value))
      : [],
  } as unknown as WorkspaceState

  const targetSessionId = mapSessionId(sourceTarget.sessionId)
  const replayed = replayDispatchState(state)
  if (
    replayed.observed.targetSessionId !== targetSessionId ||
    replayed.observed.targetVisibleLabel !== sourceTarget.label
  ) {
    throw new Error('redacted workspace changed the recorded Dispatch row ordering')
  }
  if (
    replayed.observed.targetLocalLabel !== sourceLocal ||
    replayed.observed.mismatchCount === 0
  ) {
    throw new Error('redacted workspace lost the recorded pane-label divergence')
  }
  return replayed
}

async function recordedDispatchState(): Promise<{
  state: WorkspaceState
  observed: DispatchObservation
}> {
  // WHY the default source becomes the checked-in reduced recording after the
  // first capture: workspace.json is live UI state and changed during the two
  // verification runs that exposed this bug. A fixture refresh must be an
  // explicit review event, not an incidental side effect of running a census.
  if (!REFRESH_WORKSPACE) {
    let existingText: string | null = null
    try {
      existingText = await readFile(DISPATCH_FIXTURE_FILE, 'utf8')
    } catch (error) {
      if (stringField(asRecord(error), 'code') !== 'ENOENT') throw error
    }
    if (existingText) {
      const existing = asRecord(JSON.parse(existingText))
      const state = asRecord(existing?.state)
      if (!state) throw new Error('existing Dispatch fixture has no state object')
      return replayDispatchState(state as unknown as WorkspaceState)
    }
  }

  const workspaceRaw = asRecord(JSON.parse(await readFile(WORKSPACE_FILE, 'utf8')))
  if (!workspaceRaw) throw new Error('workspace.json root is not an object')
  resetRecordedTokens()
  return reducedDispatchState(workspaceRaw)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function mapRows(map: Map<string, number>): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `| \`${name}\` | ${count.toLocaleString()} |`)
    .join('\n')
}

function censusMarkdown(params: {
  full: CodexCensus
  day: CodexCensus
  claude: ClaudeCensus
  dispatch: DispatchObservation
}): string {
  const { full, day, claude, dispatch } = params
  return `# Work-context recorded-shape census

Generated by \`scripts/extract-work-context-fixtures.mts\`. Do not hand-edit.

The cutoff is **${CUTOFF}**. The fixed cutoff matters because the measurement
process itself runs inside Codex and therefore appends new records; without it,
two consecutive extractions cannot be byte-identical.

No prompt, assistant prose, tool result, command body, raw path, session id, or
workspace title is included here. This is aggregate shape metadata only.

## Codex — full local corpus through cutoff

| Shape | Count |
|---|---:|
| files carrying relevant records | ${full.filesWithRelevantRecords.size.toLocaleString()} |
| \`session_meta\` | ${full.sessionMeta.toLocaleString()} |
| session metadata with branch | ${full.sessionMetaBranch.toLocaleString()} |
| session metadata without branch | ${full.sessionMetaNoBranch.toLocaleString()} |
| \`turn_context\` | ${full.turnContext.toLocaleString()} |
| turn context with \`workspace_roots\` array | ${full.turnWorkspaceRootsArray.toLocaleString()} |
| turn context without \`workspace_roots\` | ${full.turnWorkspaceRootsMissing.toLocaleString()} |
| \`thread_settings_applied\` | ${full.threadSettingsApplied.toLocaleString()} |
| terminal \`CommandExecution\` | ${full.commandExecution.toLocaleString()} |
| command cwd as \`file://\` URL | ${full.commandCwdFileUrl.toLocaleString()} |
| file-URL cwd with host / percent-encoding / malformed | ${full.commandCwdFileUrlWithHost.toLocaleString()} / ${full.commandCwdFileUrlPercentEncoded.toLocaleString()} / ${full.commandCwdFileUrlMalformed.toLocaleString()} |
| command cwd as absolute path | ${full.commandCwdAbsolute.toLocaleString()} |
| command cwd missing/other | ${full.commandCwdOther.toLocaleString()} |
| command represented as array | ${full.commandShapeArray.toLocaleString()} |
| command represented as string | ${full.commandShapeString.toLocaleString()} |
| terminal \`FileChange\` | ${full.fileChange.toLocaleString()} |
| FileChange \`changes\` object | ${full.fileChangeObject.toLocaleString()} |
| FileChange non-object shape | ${full.fileChangeOther.toLocaleString()} |
| changed paths total / max per record | ${full.fileChangePaths.toLocaleString()} / ${full.fileChangeMaxPaths.toLocaleString()} |
| absolute / file-URL / relative changed paths | ${full.fileChangeAbsolutePaths.toLocaleString()} / ${full.fileChangeFileUrls.toLocaleString()} / ${full.fileChangeRelativePaths.toLocaleString()} |
| changed paths with / without a recognized checkout root | ${full.fileChangePathsWithRecognizedRoot.toLocaleString()} / ${full.fileChangePathsWithoutRecognizedRoot.toLocaleString()} |
| FileChange records spanning 2+ recognized checkout roots | ${full.fileChangeMultipleRoots.toLocaleString()} |
| completed \`McpToolCall\` | ${full.mcpToolCall.toLocaleString()} |
| MCP calls whose arguments contain cwd | ${full.mcpToolCallWithCwd.toLocaleString()} |
| relevant records with no timestamp | ${full.recordsMissingTimestamp.toLocaleString()} |

The recognized-checkout count is deliberately conservative: it recognizes a
path only when the recording preserves an explicit \`.worktrees/<name>\`
boundary or this machine's recorded Development project boundary. It does not
pretend that two arbitrary parent directories are two Git worktrees. Git still
owns final candidate validation in production.

### Terminal item status catalog

| CommandExecution status | Count |
|---|---:|
${mapRows(full.commandExecutionStatuses)}

| FileChange status | Count |
|---|---:|
${mapRows(full.fileChangeStatuses)}

### Completed item catalog

| Item discriminator | Count |
|---|---:|
${mapRows(full.completedItemTypes)}

### Legacy Codex carriers already supported

| Carrier | Count |
|---|---:|
| \`exec_command_end\` | ${full.legacyExecCommandEnd.toLocaleString()} |
| \`exec_approval_request\` | ${full.legacyExecApprovalRequest.toLocaleString()} |
| \`local_shell_call\` | ${full.legacyLocalShellCall.toLocaleString()} |
| \`function_call\` | ${full.legacyFunctionCall.toLocaleString()} |

## Codex — ${CURRENT_DAY} through cutoff

| Shape | Count |
|---|---:|
| files carrying relevant records | ${day.filesWithRelevantRecords.size.toLocaleString()} |
| \`session_meta\` | ${day.sessionMeta.toLocaleString()} |
| \`turn_context\` | ${day.turnContext.toLocaleString()} |
| \`thread_settings_applied\` | ${day.threadSettingsApplied.toLocaleString()} |
| terminal \`CommandExecution\` | ${day.commandExecution.toLocaleString()} |
| command cwd as \`file://\` URL | ${day.commandCwdFileUrl.toLocaleString()} |
| terminal \`FileChange\` / object-shaped | ${day.fileChange.toLocaleString()} / ${day.fileChangeObject.toLocaleString()} |
| changed paths total / max per record | ${day.fileChangePaths.toLocaleString()} / ${day.fileChangeMaxPaths.toLocaleString()} |
| completed \`McpToolCall\` / with cwd argument | ${day.mcpToolCall.toLocaleString()} / ${day.mcpToolCallWithCwd.toLocaleString()} |

## Claude — local corpus

| Shape | Count |
|---|---:|
| files carrying relevant records | ${claude.filesWithRelevantRecords.size.toLocaleString()} |
| explicit worktree enter | ${claude.worktreeEnter.toLocaleString()} |
| explicit worktree enter with branch | ${claude.worktreeEnterWithBranch.toLocaleString()} |
| worktree enter from retained backup / current corpus | ${claude.worktreeEnterFromBackup.toLocaleString()} / ${claude.worktreeEnterFromCurrentCorpus.toLocaleString()} |
| explicit worktree exit | ${claude.worktreeExit.toLocaleString()} |
| first following conversation cwd at worktree / original / other | ${claude.firstConversationAtWorktree.toLocaleString()} / ${claude.firstConversationAtOriginalCwd.toLocaleString()} / ${claude.firstConversationAtOtherCwd.toLocaleString()} |
| enters without a following conversation record | ${claude.worktreeEnterWithoutFollowingConversation.toLocaleString()} |
| conversation entries with cwd | ${claude.conversationWithCwd.toLocaleString()} |
| conversation entries with cwd + branch | ${claude.conversationWithCwdAndBranch.toLocaleString()} |
| agent-code conversation entries with cwd | ${claude.agentCodeConversationWithCwd.toLocaleString()} |

No recorded Claude exit exists in this corpus. Production supports the upstream
null-exit contract, but Stage 2 must not label an invented null record as a real
fixture. The explicit enters are retained provider recordings, but all 11 live
under a backup corpus rather than the current project corpus. Four have a next
conversation record; every one keeps the worktree cwd.

## Persisted Dispatch snapshot

| Observation | Value |
|---|---:|
| project tabs | ${String(dispatch.tabCount)} |
| visible Global Dispatch rows | ${String(dispatch.visibleRowCount)} |
| rows whose visible and tab-local labels differ | ${String(dispatch.mismatchCount)} |
| recorded target visible label | \`${String(dispatch.targetVisibleLabel)}\` |
| same target tab-local label | \`${String(dispatch.targetLocalLabel)}\` |

The reduced fixture is verified by the production row selector before it is
written. Its D23 mismatch is therefore a property of the recorded workspace
ordering, not a label typed into a test.

## Conclusions that constrain implementation

1. Current completed commands use \`file://\` cwd values; path matching must
   normalize that recorded representation once.
2. Every recorded FileChange uses an object keyed by changed path and has
   terminal status \`completed\`. There is no evidence for an array branch or
   a failed/declined fixture; those statuses come from the vendored upstream
   protocol and must fail closed rather than be represented by invented data.
3. Real MCP calls carry child/target cwd arguments, so recursive cwd mining is
   demonstrably unsafe.
4. Recorded Claude enter-to-conversation sequences preserve worktree cwd, so
   current Claude behavior can be protected without inventing precedence.
5. Provider recognition belongs in the shared work-context boundary because
   live and historical consumers receive the same recorded grammar.
`
}

function manifestMarkdown(params: {
  transition: SelectedRecord[]
  mcp: SelectedRecord[]
  claudeEnter: SelectedRecord
  claudeEnterConversation: SelectedRecord
  claudeConversation: SelectedRecord
  dispatch: DispatchObservation
  workspaceFingerprint: string
}): string {
  const transitionRefs = sourceRefs(params.transition)
    .map(ref => `\`${ref.timestamp}\` (line ${ref.line})`)
    .join(', ')
  const claudePairRefs = `lines ${params.claudeEnter.line}/${params.claudeEnterConversation.line}`
  return `# Work-context fixtures

Generated by \`scripts/extract-work-context-fixtures.mts\`. Do not hand-edit.

These are reduced **recorded** inputs for #658 and #659. They reuse the
repository's canonical structure-only redactor and sensitive-key gate. The
extractor additionally refuses raw home paths, usernames, UUID-shaped ids, and
every output string outside a small structural allowlist.

| Fixture | Existing recorded source | Proves |
|---|---|---|
| \`codex-main-to-worktree.json\` | one Codex rollout, records ${transitionRefs} | Launch/turn/command metadata remains at main while the recorded FileChange targets a linked worktree; includes current thread settings and file-URL command cwd. |
| \`codex-mcp-child-cwd.json\` | completed MCP item at \`${CODEX_MCP_NEGATIVE_TIMESTAMP}\` | A real orchestration call carries its child's worktree cwd; it must not become current-agent evidence. |
| \`claude-worktree-context.json\` | one retained real enter and its next conversation-cwd record (${claudePairRefs}) + current conversation record at line ${params.claudeConversation.line} | Protects the Claude enter-to-worktree sequence and current conversation contract without inventing an unrecorded exit. |
| \`dispatch-global-d23.json\` | persisted workspace reduction, fingerprint \`${params.workspaceFingerprint}\` | Production selectors reproduce ${String(params.dispatch.targetVisibleLabel)} globally and ${String(params.dispatch.targetLocalLabel)} tab-locally for the same recorded session. |

## Mechanical transformations

1. Only the record envelope and fields read by work-context extraction are kept.
2. Free text is replaced by length-carrying \`⟨text:N⟩\` placeholders through
   the canonical structure-only redactor.
3. Home/project/worktree paths are deterministically mapped under
   \`/fixture/\`; \`file://\` remains \`file://\` and path topology is retained.
4. Branches, session ids, tab ids, and UUID-shaped identities become stable
   tokens. FileChange object keys keep their original ordering and cardinality.
5. The persisted workspace is reduced to fields consumed by the production
   Dispatch selectors, then replayed through those selectors before emission.

Because the persisted workspace is live mutable UI state, normal reruns
validate and re-emit the checked-in reduced Dispatch recording. Pass
\`--refresh-workspace\` to deliberately replace it from current live state; the
source fingerprint and selector observations make that refresh reviewable.

Source provider filenames/session ids are intentionally absent from this public
manifest. Timestamps/line numbers and source fingerprints provide local
traceability without publishing identities.
`
}

async function main(): Promise<void> {
  const codexFiles = await jsonlFiles(CODEX_ROOT)
  const full = emptyCodexCensus()
  const day = emptyCodexCensus()
  const selected = new Map<string, SelectedRecord>()
  for (const file of codexFiles) {
    await forEachJsonlRecord(file, (record, line) => {
      observeCodex(full, file, record)
      if (stringField(record, 'timestamp')?.startsWith(CURRENT_DAY)) {
        observeCodex(day, file, record)
      }
      selectRecord(selected, file, line, record)
    })
  }

  const requiredTimestamps = [
    ...CODEX_TRANSITION_TIMESTAMPS,
    CODEX_MCP_NEGATIVE_TIMESTAMP,
  ]
  for (const timestamp of requiredTimestamps) {
    if (!selected.has(timestamp)) {
      throw new Error(`required recorded Codex fixture ${timestamp} not found`)
    }
  }
  const transition = CODEX_TRANSITION_TIMESTAMPS.map(
    timestamp => selected.get(timestamp)!,
  )
  if (new Set(transition.map(record => record.file)).size !== 1) {
    throw new Error('Codex transition fixture records no longer share one rollout')
  }
  const mcp = [selected.get(CODEX_MCP_NEGATIVE_TIMESTAMP)!]

  const claudeFiles = await jsonlFiles(CLAUDE_ROOT)
  const claude: ClaudeCensus = {
    filesWithRelevantRecords: new Set(),
    worktreeEnter: 0,
    worktreeExit: 0,
    worktreeEnterWithBranch: 0,
    worktreeEnterFromBackup: 0,
    worktreeEnterFromCurrentCorpus: 0,
    firstConversationAtWorktree: 0,
    firstConversationAtOriginalCwd: 0,
    firstConversationAtOtherCwd: 0,
    worktreeEnterWithoutFollowingConversation: 0,
    conversationWithCwd: 0,
    conversationWithCwdAndBranch: 0,
    agentCodeConversationWithCwd: 0,
  }
  let claudeEnter: SelectedRecord | null = null
  let claudeEnterConversation: SelectedRecord | null = null
  let claudeConversation: SelectedRecord | null = null
  for (const file of claudeFiles) {
    const projectDirectory = basename(dirname(file))
    const agentCodeSource = projectDirectory.includes('agent-code')
    const currentAgentCodeSource = projectDirectory ===
      `-${HOME.split('/').filter(Boolean).join('-')}-Desktop-Development-agent-code`
    const backupSource = file.includes('/_pre-cc-shell-rename-backup/')
    let pendingEnter: {
      selected: SelectedRecord
      worktreePath: string
      originalCwd: string | null
    } | null = null
    await forEachJsonlRecord(file, (record, line) => {
      if (record.type === 'worktree-state') {
        claude.filesWithRelevantRecords.add(file)
        const session = asRecord(record.worktreeSession)
        if (session) {
          if (pendingEnter) claude.worktreeEnterWithoutFollowingConversation += 1
          claude.worktreeEnter += 1
          if (backupSource) claude.worktreeEnterFromBackup += 1
          else claude.worktreeEnterFromCurrentCorpus += 1
          if (stringField(session, 'worktreeBranch')) {
            claude.worktreeEnterWithBranch += 1
          }
          const worktreePath = stringField(session, 'worktreePath')
          pendingEnter = worktreePath
            ? {
                selected: { file, line, record },
                worktreePath,
                originalCwd: stringField(session, 'originalCwd'),
              }
            : null
        } else {
          claude.worktreeExit += 1
          pendingEnter = null
        }
      }
      const message = asRecord(record.message)
      if (
        (record.type === 'assistant' || record.type === 'user') &&
        message &&
        typeof record.cwd === 'string' &&
        recordIncluded(record)
      ) {
        claude.filesWithRelevantRecords.add(file)
        claude.conversationWithCwd += 1
        if (typeof record.gitBranch === 'string') {
          claude.conversationWithCwdAndBranch += 1
        }
        if (agentCodeSource) claude.agentCodeConversationWithCwd += 1
        if (currentAgentCodeSource && !claudeConversation) {
          claudeConversation = { file, line, record }
        }
        if (pendingEnter) {
          if (record.cwd === pendingEnter.worktreePath) {
            claude.firstConversationAtWorktree += 1
          } else if (record.cwd === pendingEnter.originalCwd) {
            claude.firstConversationAtOriginalCwd += 1
          } else {
            claude.firstConversationAtOtherCwd += 1
          }
          if (!claudeEnter) {
            claudeEnter = pendingEnter.selected
            claudeEnterConversation = { file, line, record }
          }
          pendingEnter = null
        }
      }
    })
    if (pendingEnter) claude.worktreeEnterWithoutFollowingConversation += 1
  }
  // TypeScript intentionally does not assume a callback executed or mutated an
  // outer variable. Turn each selection into a checked value at the boundary;
  // downstream fixture assembly must never carry nullable evidence.
  const selectedClaudeEnter = requiredSelectedRecord(
    claudeEnter,
    'Claude worktree enter',
  )
  const selectedClaudeEnterConversation = requiredSelectedRecord(
    claudeEnterConversation,
    'Claude post-enter conversation',
  )
  const selectedClaudeConversation = requiredSelectedRecord(
    claudeConversation,
    'current Claude conversation',
  )

  const reducedDispatch = await recordedDispatchState()
  const workspaceFingerprint = createHash('sha256')
    .update(JSON.stringify(reducedDispatch.state))
    .digest('hex')
    .slice(0, 16)

  resetRecordedTokens()
  const transitionRecords = transition.map(selectedRecord => (
    redactProviderRecord(projectedCodexRecord(selectedRecord.record))
  ))
  resetRecordedTokens()
  const mcpRecords = mcp.map(selectedRecord => (
    redactProviderRecord(projectedCodexRecord(selectedRecord.record))
  ))
  resetRecordedTokens()
  const claudeRecords = [
    selectedClaudeEnter,
    selectedClaudeEnterConversation,
    selectedClaudeConversation,
  ].map(selectedRecord => (
    redactProviderRecord(projectClaudeRecord(selectedRecord.record))
  ))

  assertPublishablePayload(transitionRecords, 'codex-main-to-worktree')
  assertPublishablePayload(mcpRecords, 'codex-mcp-child-cwd')
  assertPublishablePayload(claudeRecords, 'claude-worktree-context')
  assertPublishablePayload(reducedDispatch.state, 'dispatch-global-d23')

  await mkdir(FIXTURE_DIR, { recursive: true })
  await mkdir(EVIDENCE_DIR, { recursive: true })

  await writeJson(join(FIXTURE_DIR, 'codex-main-to-worktree.json'), {
    $fixture: {
      id: 'codex-main-to-worktree',
      cutoff: CUTOFF,
      source: 'codex-rollout-a',
      sourceFingerprint: sourceFingerprint(transition),
      records: sourceRefs(transition),
    },
    records: transitionRecords,
  })
  await writeJson(join(FIXTURE_DIR, 'codex-mcp-child-cwd.json'), {
    $fixture: {
      id: 'codex-mcp-child-cwd',
      cutoff: CUTOFF,
      source: 'codex-rollout-b',
      sourceFingerprint: sourceFingerprint(mcp),
      records: sourceRefs(mcp),
    },
    records: mcpRecords,
  })
  await writeJson(join(FIXTURE_DIR, 'claude-worktree-context.json'), {
    $fixture: {
      id: 'claude-worktree-context',
      cutoff: CUTOFF,
      sources: [
        {
          alias: 'claude-worktree-state-a',
          line: selectedClaudeEnter.line,
          sourceFingerprint: sourceFingerprint([selectedClaudeEnter]),
        },
        {
          alias: 'claude-worktree-conversation-a',
          line: selectedClaudeEnterConversation.line,
          timestamp: stringField(selectedClaudeEnterConversation.record, 'timestamp'),
          sourceFingerprint: sourceFingerprint([selectedClaudeEnterConversation]),
        },
        {
          alias: 'claude-current-conversation-a',
          line: selectedClaudeConversation.line,
          timestamp: stringField(selectedClaudeConversation.record, 'timestamp'),
          sourceFingerprint: sourceFingerprint([selectedClaudeConversation]),
        },
      ],
    },
    records: claudeRecords,
  })
  await writeJson(DISPATCH_FIXTURE_FILE, {
    $fixture: {
      id: 'dispatch-global-d23',
      source: 'persisted-agent-code-workspace',
      sourceFingerprint: workspaceFingerprint,
      observed: reducedDispatch.observed,
    },
    state: reducedDispatch.state,
  })

  await writeFile(
    join(EVIDENCE_DIR, 'shape-census.md'),
    censusMarkdown({
      full,
      day,
      claude,
      dispatch: reducedDispatch.observed,
    }),
    'utf8',
  )
  await writeFile(
    join(FIXTURE_DIR, 'MANIFEST.md'),
    manifestMarkdown({
      transition,
      mcp,
      claudeEnter: selectedClaudeEnter,
      claudeEnterConversation: selectedClaudeEnterConversation,
      claudeConversation: selectedClaudeConversation,
      dispatch: reducedDispatch.observed,
      workspaceFingerprint,
    }),
    'utf8',
  )

  console.log(`Codex files scanned: ${codexFiles.length}`)
  console.log(`Claude files scanned: ${claudeFiles.length}`)
  console.log(`Fixtures written: ${FIXTURE_DIR}`)
  console.log(`Census written: ${join(EVIDENCE_DIR, 'shape-census.md')}`)
}

await main()
