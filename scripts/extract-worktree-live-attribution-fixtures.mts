#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Real failing recordings -> public live-worktree-attribution fixtures.
//
// WHY this is a separate extractor from extract-work-context-fixtures.mts:
// that earlier corpus has an immutable August 26 cutoff and proves provider
// grammar in isolation. The regression here is specifically the August 30
// live boundary: Claude metadata contradicts direct tool paths, while Codex
// 0.151 never delivers its otherwise-correct rollout to the renderer. Folding
// a new moving cutoff into the old extractor would make its already-reviewed
// fixtures drift and obscure which recording proves which contract.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'

import { findSensitiveSurvivors } from '../src/renderer/src/rendering/replay/redact.js'
import { sanitizePathSegment } from '../src/shared/runtime/projectDir.js'

type JsonRecord = Record<string, unknown>

type LocatedRecord = {
  file: string
  line: number
  record: JsonRecord
}

type GitIdentity = {
  path: string
  branch: string | null
  detached: boolean
}

type SelectedGit = {
  main: GitIdentity
  grid: GitIdentity
  ui: GitIdentity
}

const exec = promisify(execFile)
// WHY this narrow compatibility cast exists: Agent Code's Node/Electron
// runtime already exposes the stable synchronous zstd API (and the recorded
// proxy bodies require it), while the repository's pinned @types/node predates
// those two declarations. Keeping the cast at one boundary is safer than
// weakening the whole script to `any` or shelling out to a machine-specific
// zstd binary that packaged verification cannot assume exists.
const zstd = zlib as typeof zlib & {
  zstdCompressSync(input: Uint8Array): Buffer
  zstdDecompressSync(input: Uint8Array): Buffer
}
const HOME = homedir()
const REPO = resolve(import.meta.dirname, '..')
const FIXTURE_DIR = join(REPO, 'testing', 'fixtures', 'worktree-live-attribution')
const EVIDENCE_DIR = join(
  REPO,
  'docs',
  'decomposition',
  'evidence',
  'worktree-live-attribution',
)
const CLAUDE_ROOT = join(HOME, '.claude', 'projects')
const CODEX_DAY_ROOT = join(HOME, '.codex', 'sessions', '2026', '08', '30')
const AGENT_CODE_ROOT = join(HOME, '.config', 'agent-code')
const WORKSPACE_FILE = join(AGENT_CODE_ROOT, 'workspace.json')
const PROXY_ROOT = join(AGENT_CODE_ROOT, 'proxy')
const RECORDING_ROOT = join(AGENT_CODE_ROOT, 'session-recordings')
const FEED_DEBUG_ROOT = join(AGENT_CODE_ROOT, 'feed-debug')
const FIXTURE_NAMES = [
  'claude-cwd-tool-branch-conflict.json',
  'codex-0151-worktree-window.json',
  'codex-proxy-exact-identity-zstd.json',
  'codex-live-channel-gap.json',
  'git-worktree-identities.json',
] as const

// WHY one cutoff spans both provider recordings: the reported Codex failure
// was observed immediately after this final worktree command, and the Claude
// session already contains both contradiction shapes before the same instant.
// The extraction itself runs inside the Codex rollout, so "read to EOF" would
// be nondeterministic by construction.
const CUTOFF = '2026-08-30T18:37:55.388Z'
const CUTOFF_MS = Date.parse(CUTOFF)
const PROXY_REQUEST_PREFIX = 128

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
const SHA = /^[0-9a-f]{16}$/
const TOKEN_PATH = /^(?:file:\/\/)?\/fixture\/(?:project-1|home|external)(?:\/(?:path-\d+|\.worktrees\/worktree-[12]))*$/
const TOKEN_ID = /^(?:fixture-id|agent-session)-\d+$/
const TOKEN_BRANCH = /^fixture\/branch-\d+$/
const TOKEN_TEXT = /^⟨text:\d+⟩$/

const ALLOWED_STRINGS = new Set([
  'assistant',
  'tool_use',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'session_meta',
  'event_msg',
  'item_completed',
  'CommandExecution',
  'completed',
  'failed',
  'codex',
  'session:started',
  'session:jsonl-error',
  'Codex prompt evidence disabled: unsupported-cli',
  'request',
  'responses',
  'POST',
  '/v1/responses',
  'zstd',
  'application/json',
  'main',
  'grid-worktree',
  'ui-worktree',
  'other',
  'missing',
  'claude-cwd-tool-branch-conflict',
  'codex-0151-worktree-window',
  'codex-proxy-exact-identity-zstd',
  'codex-live-channel-gap',
  'git-worktree-identities',
  'client_metadata only; deterministically recompressed',
])

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function stringField(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function requiredLocated(
  value: LocatedRecord | null,
  label: string,
): LocatedRecord {
  if (!value) throw new Error(`required recorded ${label} was not found`)
  return value
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
    entries.sort((left, right) => left.name.localeCompare(right.name))
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
  visit: (record: JsonRecord, line: number, raw: string) => boolean | void,
): Promise<void> {
  const input = createReadStream(file)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let line = 0
  for await (const text of lines) {
    line += 1
    if (!text) continue
    try {
      const record = asRecord(JSON.parse(text))
      if (record && visit(record, line, text) === false) break
    } catch {
      // WHY torn provider lines are ignored: both production tailers skip an
      // incomplete append and retry when more bytes arrive. The extractor must
      // observe the same record population or its census can disagree with the
      // parser for an artifact that was never a complete JSON object.
    }
  }
}

function fingerprint(values: readonly unknown[]): string {
  const hash = createHash('sha256')
  for (const value of values) hash.update(JSON.stringify(value))
  return hash.digest('hex').slice(0, 16)
}

function mapCounts(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  )
}

function parseGitWorktrees(output: string): GitIdentity[] {
  const identities: GitIdentity[] = []
  let current: GitIdentity | null = null
  for (const line of output.split('\n')) {
    if (!line) {
      if (current) identities.push(current)
      current = null
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') {
      if (current) identities.push(current)
      current = { path: value, branch: null, detached: false }
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '') || null
    } else if (current && key === 'detached') {
      current.detached = true
    }
  }
  if (current) identities.push(current)
  return identities
}

async function selectedGitIdentities(): Promise<SelectedGit> {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: REPO,
  })
  const identities = parseGitWorktrees(stdout)
  const grid = identities.find(identity => (
    identity.path.endsWith('/.worktrees/grid-dispatch-mode')
  ))
  const ui = identities.find(identity => (
    identity.path.endsWith('/.worktrees/ui-containment-radius')
  ))
  const main = identities[0]
  if (!main || !grid || !ui) {
    throw new Error('required main/grid/UI Git worktree identity is unavailable')
  }
  if (!main.branch || !grid.branch || !ui.branch) {
    throw new Error('recorded main/grid/UI Git fixture unexpectedly detached')
  }
  return { main, grid, ui }
}

class Tokenizer {
  private readonly pathSegments = new Map<string, string>()
  private readonly identities = new Map<string, string>()
  private readonly branches = new Map<string, string>()
  private readonly roots: Array<{ source: string; token: string }>

  constructor(git: SelectedGit) {
    // WHY roots are explicit and longest-first: the linked worktrees live
    // below the main checkout. Prefix-matching main first would erase the
    // `.worktrees/<name>` topology that the fixtures exist to preserve.
    this.roots = [
      { source: git.grid.path, token: '/fixture/project-1/.worktrees/worktree-1' },
      { source: git.ui.path, token: '/fixture/project-1/.worktrees/worktree-2' },
      { source: git.main.path, token: '/fixture/project-1' },
    ].sort((left, right) => right.source.length - left.source.length)
  }

  path(value: string): string {
    const isFileUrl = value.startsWith('file:')
    let source = value
    if (isFileUrl) {
      try {
        const url = new URL(value)
        source = decodeURIComponent(url.pathname)
      } catch {
        return 'file:///fixture/external/path-1'
      }
    }
    const root = this.roots.find(candidate => (
      source === candidate.source || source.startsWith(`${candidate.source}/`)
    ))
    let token: string
    if (root) {
      token = `${root.token}${this.tail(source.slice(root.source.length))}`
    } else if (source === HOME || source.startsWith(`${HOME}/`)) {
      token = `/fixture/home${this.tail(source.slice(HOME.length))}`
    } else {
      token = `/fixture/external${this.tail(source)}`
    }
    return isFileUrl ? `file://${token}` : token
  }

  branch(value: string): string {
    const existing = this.branches.get(value)
    if (existing) return existing
    const token = `fixture/branch-${this.branches.size + 1}`
    this.branches.set(value, token)
    return token
  }

  id(value: string, prefix = 'fixture-id'): string {
    const key = `${prefix}\0${value}`
    const existing = this.identities.get(key)
    if (existing) return existing
    const count = [...this.identities.keys()].filter(item => (
      item.startsWith(`${prefix}\0`)
    )).length
    const token = `${prefix}-${count + 1}`
    this.identities.set(key, token)
    return token
  }

  private tail(value: string): string {
    const parts = value.split('/').filter(Boolean)
    if (parts.length === 0) return ''
    return `/${parts.map(part => {
      const existing = this.pathSegments.get(part)
      if (existing) return existing
      const token = `path-${this.pathSegments.size + 1}`
      this.pathSegments.set(part, token)
      return token
    }).join('/')}`
  }
}

function directToolPath(block: JsonRecord): { field: string; path: string } | null {
  if (block.type !== 'tool_use') return null
  const input = asRecord(block.input)
  if (!input) return null
  for (const field of ['file_path', 'path', 'cwd', 'workdir']) {
    const path = stringField(input, field)
    if (path?.startsWith('/')) return { field, path }
  }
  return null
}

function toolBlocks(record: JsonRecord): JsonRecord[] {
  const message = asRecord(record.message)
  return Array.isArray(message?.content)
    ? message.content.map(asRecord).filter((value): value is JsonRecord => Boolean(value))
    : []
}

async function collectClaude(
  git: SelectedGit,
  tokens: Tokenizer,
): Promise<{
  fixture: JsonRecord
  census: JsonRecord
}> {
  const projectDirectory = join(
    CLAUDE_ROOT,
    git.main.path.replace(/[^a-zA-Z0-9]/g, '-'),
  )
  const files = await jsonlFiles(projectDirectory)
  let filesThroughCutoff = 0
  const candidates: Array<{
    counts: Map<string, number>
    toolPathCount: number
    mainConflict: LocatedRecord
    staleBranchConflict: LocatedRecord
  }> = []

  for (const file of files) {
    let sawRecordThroughCutoff = false
    const counts = new Map<string, number>()
    let toolPathCount = 0
    let mainConflict: LocatedRecord | null = null
    let staleBranchConflict: LocatedRecord | null = null
    await forEachJsonlRecord(file, (record, line) => {
      const timestamp = stringField(record, 'timestamp')
      if (!timestamp || timestamp > CUTOFF) return
      sawRecordThroughCutoff = true
      const cwd = stringField(record, 'cwd')
      const branch = stringField(record, 'gitBranch')
      if (
        (record.type === 'assistant' || record.type === 'user') &&
        cwd === git.grid.path && branch === git.main.branch
      ) {
        increment(counts, `${String(record.type)}:grid-cwd:main-branch`)
      }
      if (record.type !== 'assistant') return

      const gridTools = toolBlocks(record)
        .map(block => ({ block, direct: directToolPath(block) }))
        .filter(item => item.direct && (
          item.direct.path === git.grid.path ||
          item.direct.path.startsWith(`${git.grid.path}/`)
        ))
      if (gridTools.length === 0) return
      toolPathCount += gridTools.length
      const located = { file, line, record }
      if (!mainConflict && cwd === git.main.path && branch === git.main.branch) {
        mainConflict = located
      }
      if (!staleBranchConflict && cwd === git.grid.path && branch === git.main.branch) {
        staleBranchConflict = located
      }
    })
    if (sawRecordThroughCutoff) filesThroughCutoff += 1
    if (mainConflict && staleBranchConflict) {
      candidates.push({
        counts,
        toolPathCount,
        mainConflict,
        staleBranchConflict,
      })
    }
  }

  // WHY both rows must come from one provider transcript: selecting one
  // contradiction from each of two sessions would manufacture a sequence no
  // real agent experienced. The user supplied one resumed session and the
  // checked-in fixture must remain one ordered slice of that same file.
  if (candidates.length !== 1) {
    throw new Error(`expected one Claude conflict transcript, found ${candidates.length}`)
  }
  const candidate = candidates[0]!
  const selected = [candidate.mainConflict, candidate.staleBranchConflict]
  const records = selected.map(located => {
    const record = located.record
    const direct = toolBlocks(record)
      .map(block => ({ block, direct: directToolPath(block) }))
      .find(item => item.direct && (
        item.direct.path === git.grid.path ||
        item.direct.path.startsWith(`${git.grid.path}/`)
      ))
    if (!direct?.direct) throw new Error('selected Claude record lost direct tool path')
    return {
      type: 'assistant',
      timestamp: record.timestamp,
      cwd: tokens.path(String(record.cwd)),
      gitBranch: tokens.branch(String(record.gitBranch)),
      message: {
        content: [{
          type: 'tool_use',
          name: direct.block.name,
          input: {
            [direct.direct.field]: tokens.path(direct.direct.path),
          },
        }],
      },
    }
  })

  return {
    fixture: {
      $fixture: {
        id: 'claude-cwd-tool-branch-conflict',
        cutoff: CUTOFF,
        sourceFingerprint: fingerprint(selected.map(item => item.record)),
        records: selected.map(item => ({
          line: item.line,
          timestamp: stringField(item.record, 'timestamp'),
        })),
      },
      git: {
        main: { path: tokens.path(git.main.path), branch: tokens.branch(git.main.branch!) },
        grid: { path: tokens.path(git.grid.path), branch: tokens.branch(git.grid.branch!) },
      },
      records,
    },
    census: {
      filesScanned: filesThroughCutoff,
      directGridToolPaths: candidate.toolPathCount,
      disagreementCounts: mapCounts(candidate.counts),
    },
  }
}

function completedCommand(record: JsonRecord): JsonRecord | null {
  if (record.type !== 'event_msg') return null
  const payload = asRecord(record.payload)
  const item = asRecord(payload?.item)
  return payload?.type === 'item_completed' && item?.type === 'CommandExecution'
    ? item
    : null
}

function classifyPath(value: string | null, git: SelectedGit): string {
  if (!value) return 'missing'
  let path = value
  if (value.startsWith('file:')) {
    try { path = decodeURIComponent(new URL(value).pathname) } catch { return 'other' }
  }
  if (path === git.main.path || path.startsWith(`${git.main.path}/`) &&
    !path.startsWith(`${git.main.path}/.worktrees/`)) return 'main'
  if (path === git.grid.path || path.startsWith(`${git.grid.path}/`)) return 'grid-worktree'
  if (path === git.ui.path || path.startsWith(`${git.ui.path}/`)) return 'ui-worktree'
  return 'other'
}

function redactedCommand(value: unknown): unknown {
  if (typeof value === 'string') return `⟨text:${value.length}⟩`
  if (Array.isArray(value)) return value.map(item => (
    typeof item === 'string' ? `⟨text:${item.length}⟩` : null
  ))
  return undefined
}

async function collectCodex(
  git: SelectedGit,
  tokens: Tokenizer,
): Promise<{
  fixture: JsonRecord
  census: JsonRecord
  providerId: string
}> {
  const files = await jsonlFiles(CODEX_DAY_ROOT)
  let filesThroughCutoff = 0
  const candidates: Array<{
    meta: LocatedRecord
    commands: LocatedRecord[]
  }> = []

  for (const file of files) {
    let sawRecordThroughCutoff = false
    let meta: LocatedRecord | null = null
    const commands: LocatedRecord[] = []
    await forEachJsonlRecord(file, (record, line) => {
      const timestamp = stringField(record, 'timestamp')
      if (!timestamp || timestamp > CUTOFF) return
      sawRecordThroughCutoff = true
      const payload = asRecord(record.payload)
      if (
        record.type === 'session_meta' &&
        payload?.cwd === git.main.path &&
        payload.cli_version === '0.151.0'
      ) {
        meta = { file, line, record }
      }
      const item = completedCommand(record)
      if (item) {
        const located = { file, line, record }
        commands.push(located)
      }
    })
    if (sawRecordThroughCutoff) filesThroughCutoff += 1
    if (!meta) continue
    const tail = commands
      .filter(item => stringField(asRecord(asRecord(item.record.payload)?.item), 'status') === 'completed')
      .slice(-12)
    if (
      tail.length === 12 &&
      tail.every(item => classifyPath(
        stringField(asRecord(asRecord(item.record.payload)?.item), 'cwd'),
        git,
      ) === 'ui-worktree')
    ) {
      candidates.push({ meta, commands })
    }
  }

  if (candidates.length !== 1) {
    throw new Error(`expected one Codex 0.151 UI-tail rollout, found ${candidates.length}`)
  }
  const candidate = candidates[0]!
  const payload = asRecord(candidate.meta.record.payload)
  const providerId = stringField(payload, 'id')
  if (!providerId) throw new Error('selected Codex session_meta has no id')
  const completedTail = candidate.commands
    .filter(item => stringField(asRecord(asRecord(item.record.payload)?.item), 'status') === 'completed')
    .slice(-12)
  const selected = [candidate.meta, ...completedTail]
  const statusByPath = new Map<string, number>()
  for (const located of candidate.commands) {
    const item = asRecord(asRecord(located.record.payload)?.item)
    increment(
      statusByPath,
      `${classifyPath(stringField(item, 'cwd'), git)}:${stringField(item, 'status') ?? 'missing'}`,
    )
  }

  const projected = selected.map((located, index) => {
    if (index === 0) {
      const source = asRecord(located.record.payload)!
      const sourceGit = asRecord(source.git)
      return {
        type: 'session_meta',
        timestamp: located.record.timestamp,
        payload: {
          id: tokens.id(providerId),
          cwd: tokens.path(String(source.cwd)),
          cli_version: source.cli_version,
          git: {
            branch: tokens.branch(String(sourceGit?.branch)),
          },
        },
      }
    }
    const sourcePayload = asRecord(located.record.payload)!
    const sourceItem = asRecord(sourcePayload.item)!
    return {
      type: 'event_msg',
      timestamp: located.record.timestamp,
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          status: sourceItem.status,
          cwd: tokens.path(String(sourceItem.cwd)),
          command: redactedCommand(sourceItem.command),
        },
      },
    }
  })

  return {
    fixture: {
      $fixture: {
        id: 'codex-0151-worktree-window',
        cutoff: CUTOFF,
        sourceFingerprint: fingerprint(selected.map(item => item.record)),
        records: selected.map(item => ({
          line: item.line,
          timestamp: stringField(item.record, 'timestamp'),
        })),
      },
      git: {
        main: { path: tokens.path(git.main.path), branch: tokens.branch(git.main.branch!) },
        ui: { path: tokens.path(git.ui.path), branch: tokens.branch(git.ui.branch!) },
      },
      records: projected,
    },
    census: {
      filesScanned: filesThroughCutoff,
      commandCounts: mapCounts(statusByPath),
      completedTail: completedTail.length,
      completedTailPath: 'ui-worktree',
      cliVersion: '0.151.0',
    },
    providerId,
  }
}

function decodeProxyBody(event: JsonRecord): {
  body: JsonRecord
  encoding: 'zstd' | 'identity'
} | null {
  const encoded = stringField(event, 'body_b64')
  if (!encoded) return null
  let bytes = Buffer.from(encoded, 'base64')
  let encoding: 'zstd' | 'identity' = 'identity'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x28 && bytes[1] === 0xb5 &&
    bytes[2] === 0x2f && bytes[3] === 0xfd
  ) {
    bytes = Buffer.from(zstd.zstdDecompressSync(bytes))
    encoding = 'zstd'
  }
  try {
    const body = asRecord(JSON.parse(bytes.toString('utf8')))
    return body ? { body, encoding } : null
  } catch {
    return null
  }
}

async function firstProxyThreadId(file: string): Promise<string | null> {
  let threadId: string | null = null
  await forEachJsonlRecord(file, record => {
    if (record.kind !== 'request' || record.endpoint !== 'responses') return
    const decoded = decodeProxyBody(record)
    threadId = stringField(asRecord(decoded?.body.client_metadata), 'thread_id')
    return false
  })
  return threadId
}

async function locateLiveSession(
  git: SelectedGit,
  providerId: string,
): Promise<{
  appSessionId: string
  workspaceMeta: JsonRecord
  proxyFile: string
  recordingDirectory: string
  feedDebugFile: string
}> {
  const workspaceRoot = asRecord(JSON.parse(await readFile(WORKSPACE_FILE, 'utf8')))
  const workspace = asRecord(workspaceRoot?.workspace)
  const sessions = asRecord(workspace?.sessions)
  if (!sessions) throw new Error('workspace snapshot has no sessions map')
  const projectProxyRoot = join(PROXY_ROOT, sanitizePathSegment(git.main.path))
  const matches: Array<{
    appSessionId: string
    workspaceMeta: JsonRecord
    proxyFile: string
  }> = []

  for (const [sessionId, value] of Object.entries(sessions)) {
    const meta = asRecord(value)
    if (
      !meta || meta.kind !== 'codex' || meta.cwd !== git.main.path ||
      meta.providerSessionId != null
    ) continue
    const sessionProxyRoot = join(
      projectProxyRoot,
      sanitizePathSegment(`shell-${sessionId}`),
    )
    const files = await jsonlFiles(sessionProxyRoot)
    for (const file of files) {
      if (await firstProxyThreadId(file) === providerId) {
        matches.push({ appSessionId: sessionId, workspaceMeta: meta, proxyFile: file })
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one live Agent Code/proxy identity join, found ${matches.length}`)
  }
  const match = matches[0]!
  const recordingNames = (await readdir(RECORDING_ROOT, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith(`-${match.appSessionId}`))
    .map(entry => entry.name)
    .sort()
  if (recordingNames.length !== 1) {
    throw new Error(`expected one matching Agent Code recording, found ${recordingNames.length}`)
  }
  return {
    ...match,
    recordingDirectory: join(RECORDING_ROOT, recordingNames[0]!),
    feedDebugFile: join(FEED_DEBUG_ROOT, `${match.appSessionId}.jsonl`),
  }
}

async function collectProxy(
  file: string,
  providerId: string,
  tokens: Tokenizer,
): Promise<{ fixture: JsonRecord; census: JsonRecord }> {
  let first: LocatedRecord | null = null
  let requests = 0
  let zstdBodies = 0
  let parsedBodies = 0
  let threadMatches = 0
  let sessionMatches = 0
  let equalThreadAndSession = 0
  let requestShapePresent = 0

  await forEachJsonlRecord(file, (record, line) => {
    if (record.kind !== 'request' || record.endpoint !== 'responses') return
    if (requests >= PROXY_REQUEST_PREFIX) return false
    requests += 1
    if (!first) first = { file, line, record }
    if (asRecord(record.request_shape)) requestShapePresent += 1
    const decoded = decodeProxyBody(record)
    if (!decoded) return
    parsedBodies += 1
    if (decoded.encoding === 'zstd') zstdBodies += 1
    const metadata = asRecord(decoded.body.client_metadata)
    const threadId = stringField(metadata, 'thread_id')
    const sessionId = stringField(metadata, 'session_id')
    if (threadId === providerId) threadMatches += 1
    if (sessionId === providerId) sessionMatches += 1
    if (threadId && threadId === sessionId) equalThreadAndSession += 1
  })

  // TypeScript cannot prove that the synchronous JSONL callback assigned this
  // outer variable. Collapse nullability at the evidence boundary so every
  // later provenance read is statically tied to a real selected record.
  const selectedFirst = requiredLocated(first, 'proxy responses request')
  if (
    requests !== PROXY_REQUEST_PREFIX || parsedBodies !== requests ||
    zstdBodies !== requests || threadMatches !== requests ||
    sessionMatches !== requests || equalThreadAndSession !== requests
  ) {
    throw new Error('proxy request prefix does not preserve exact recorded identity')
  }
  const decoded = decodeProxyBody(selectedFirst.record)
  const metadata = asRecord(decoded?.body.client_metadata)
  const threadId = stringField(metadata, 'thread_id')
  const sessionId = stringField(metadata, 'session_id')
  const rootTurnId = stringField(metadata, 'root_turn_id')
  if (!threadId || !sessionId || !rootTurnId) {
    throw new Error('first proxy request lacks recorded client identity metadata')
  }

  // WHY the checked-in body is deterministically recompressed after projection:
  // the original zstd frame contains the full conversation and tool schema.
  // Tests need the real transport representation and field nesting, not private
  // content. Keeping only client_metadata then recompressing preserves exactly
  // the parser boundary while making it impossible to recover prompts from the
  // public fixture.
  const minimizedBody = {
    client_metadata: {
      thread_id: tokens.id(threadId),
      session_id: tokens.id(sessionId),
      root_turn_id: tokens.id(rootTurnId),
    },
  }
  const compressed = zstd.zstdCompressSync(Buffer.from(JSON.stringify(minimizedBody)))
  const roundTrip = JSON.parse(zstd.zstdDecompressSync(compressed).toString('utf8'))
  if (JSON.stringify(roundTrip) !== JSON.stringify(minimizedBody)) {
    throw new Error('minimized proxy identity did not survive zstd round trip')
  }
  const event = {
    kind: 'request',
    endpoint: 'responses',
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    recordedEncoding: 'zstd',
    body_b64: compressed.toString('base64'),
  }

  return {
    fixture: {
      $fixture: {
        id: 'codex-proxy-exact-identity-zstd',
        cutoff: CUTOFF,
        sourceFingerprint: fingerprint([selectedFirst.record]),
        record: { line: selectedFirst.line },
        projection: 'client_metadata only; deterministically recompressed',
      },
      event,
      expected: {
        threadId: tokens.id(threadId),
        sessionId: tokens.id(sessionId),
        rootTurnId: tokens.id(rootTurnId),
      },
    },
    census: {
      fixedRequestPrefix: PROXY_REQUEST_PREFIX,
      parsedBodies,
      zstdBodies,
      threadMatches,
      sessionMatches,
      equalThreadAndSession,
      requestShapePresent,
      uniqueThreadIds: 1,
    },
  }
}

async function collectLiveGap(
  located: Awaited<ReturnType<typeof locateLiveSession>>,
  tokens: Tokenizer,
): Promise<{ fixture: JsonRecord; census: JsonRecord }> {
  const metaFile = join(located.recordingDirectory, 'meta.json')
  const eventsFile = join(located.recordingDirectory, 'events.jsonl')
  const recordingMeta = asRecord(JSON.parse(await readFile(metaFile, 'utf8')))
  if (!recordingMeta) throw new Error('matching recording meta is not an object')

  const channelCounts = new Map<string, number>()
  const selectedEvents: LocatedRecord[] = []
  await forEachJsonlRecord(eventsFile, (record, line) => {
    const wall = typeof record.wall === 'number' ? record.wall : null
    if (wall !== null && wall > CUTOFF_MS) return
    const channel = stringField(record, 'ch') ?? 'missing'
    increment(channelCounts, channel)
    if (channel === 'session:started' || channel === 'session:jsonl-error') {
      selectedEvents.push({ file: eventsFile, line, record })
    }
  })
  const feedCounts = new Map<string, number>()
  await forEachJsonlRecord(located.feedDebugFile, record => {
    const ts = typeof record.ts === 'number' ? record.ts : null
    if (ts !== null && ts > CUTOFF_MS) return
    increment(feedCounts, stringField(record, 'kind') ?? 'missing')
  })

  if ((channelCounts.get('session:jsonl-entries') ?? 0) !== 0) {
    throw new Error('recorded live gap unexpectedly contains JSONL entries')
  }
  const started = selectedEvents.find(item => item.record.ch === 'session:started')
  const error = selectedEvents.find(item => item.record.ch === 'session:jsonl-error')
  if (!started || !error) throw new Error('recorded live gap lacks start/error evidence')
  const startPayload = asRecord(started.record.payload)
  const errorPayload = asRecord(error.record.payload)
  if (errorPayload?.message !== 'Codex prompt evidence disabled: unsupported-cli') {
    throw new Error('recorded Codex unsupported-cli evidence changed')
  }
  const workspaceCwd = stringField(located.workspaceMeta, 'cwd')
  const recordingCwd = stringField(recordingMeta, 'cwd')
  const projectDir = stringField(startPayload, 'projectDir')
  if (!workspaceCwd || !recordingCwd || !projectDir) {
    throw new Error('recorded live gap lacks cwd topology')
  }

  const projectedChannelCounts = mapCounts(channelCounts)
  const projectedFeedCounts = mapCounts(feedCounts)
  return {
    fixture: {
      $fixture: {
        id: 'codex-live-channel-gap',
        cutoff: CUTOFF,
        sourceFingerprint: fingerprint([
          recordingMeta,
          ...selectedEvents.map(item => item.record),
          projectedChannelCounts,
          projectedFeedCounts,
        ]),
        records: selectedEvents.map(item => ({ line: item.line, channel: item.record.ch })),
      },
      workspace: {
        kind: located.workspaceMeta.kind,
        cwd: tokens.path(workspaceCwd),
        providerSessionId: null,
      },
      recording: {
        provider: recordingMeta.provider,
        providerSessionId: null,
        cwd: tokens.path(recordingCwd),
      },
      events: [
        {
          ch: 'session:started',
          payload: {
            sessionId: tokens.id(located.appSessionId, 'agent-session'),
            kind: startPayload?.kind,
            projectDir: tokens.path(projectDir),
          },
        },
        {
          ch: 'session:jsonl-error',
          payload: {
            sessionId: tokens.id(located.appSessionId, 'agent-session'),
            message: errorPayload.message,
          },
        },
      ],
      channelCounts: projectedChannelCounts,
      feedKindCounts: projectedFeedCounts,
    },
    census: {
      channelCounts: projectedChannelCounts,
      feedKindCounts: projectedFeedCounts,
      jsonlEntries: 0,
      workspaceProviderSessionId: null,
      recordingProviderSessionId: null,
    },
  }
}

function gitFixture(git: SelectedGit, tokens: Tokenizer): JsonRecord {
  return {
    $fixture: {
      id: 'git-worktree-identities',
      cutoff: CUTOFF,
      sourceFingerprint: fingerprint([git.main, git.grid, git.ui]),
    },
    worktrees: [
      {
        role: 'main',
        path: tokens.path(git.main.path),
        branch: tokens.branch(git.main.branch!),
        detached: git.main.detached,
      },
      {
        role: 'grid-worktree',
        path: tokens.path(git.grid.path),
        branch: tokens.branch(git.grid.branch!),
        detached: git.grid.detached,
      },
      {
        role: 'ui-worktree',
        path: tokens.path(git.ui.path),
        branch: tokens.branch(git.ui.branch!),
        detached: git.ui.detached,
      },
    ],
  }
}

function allowedFixtureString(value: string, path: string): boolean {
  // WHY base64 is allowed only at this one reviewed field: a global base64
  // regex also accepts ordinary alphanumeric prose and would turn the string
  // allowlist into theater. The encoded bytes are generated above from the
  // minimized token-only object and immediately round-tripped before emission.
  if (path.endsWith('.body_b64')) return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  return ALLOWED_STRINGS.has(value) ||
    /^2026-08-30T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    /^0\.151\.0$/.test(value) ||
    SHA.test(value) ||
    TOKEN_PATH.test(value) ||
    TOKEN_ID.test(value) ||
    TOKEN_BRANCH.test(value) ||
    TOKEN_TEXT.test(value)
}

function assertPublishable(value: unknown, label: string): void {
  const sensitive = findSensitiveSurvivors(value)
  if (sensitive.length > 0) {
    throw new Error(`refusing ${label}: sensitive values survived at ${sensitive.join(', ')}`)
  }
  const serialized = JSON.stringify(value)
  const username = basename(HOME)
  if (serialized.includes(HOME) || serialized.includes(username)) {
    throw new Error(`refusing ${label}: operator home or username survived`)
  }
  if (UUID.test(serialized)) {
    throw new Error(`refusing ${label}: UUID-shaped identity survived`)
  }

  const rejected: string[] = []
  const walk = (item: unknown, path: string): void => {
    if (typeof item === 'string') {
      if (!allowedFixtureString(item, path)) rejected.push(`${path}=${item.slice(0, 80)}`)
      return
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, `${path}[${index}]`))
      return
    }
    const record = asRecord(item)
    if (!record) return
    for (const [key, child] of Object.entries(record)) {
      walk(child, path ? `${path}.${key}` : key)
    }
  }
  walk(value, '')
  if (rejected.length > 0) {
    throw new Error(
      `refusing ${label}: non-allowlisted strings survived\n${rejected.slice(0, 20).join('\n')}`,
    )
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function censusMarkdown(params: {
  claude: JsonRecord
  codex: JsonRecord
  proxy: JsonRecord
  live: JsonRecord
}): string {
  const claudeCounts = asRecord(params.claude.disagreementCounts) ?? {}
  const codexCounts = asRecord(params.codex.commandCounts) ?? {}
  const channels = asRecord(params.live.channelCounts) ?? {}
  return `# Live worktree attribution recorded-shape census

Generated by \`scripts/extract-worktree-live-attribution-fixtures.mts\`.
Do not hand-edit.

The provider/session cutoff is **${CUTOFF}**. The proxy identity census uses the
first **${PROXY_REQUEST_PREFIX}** \`/responses\` requests because proxy events do
not carry wall timestamps; a fixed source-order prefix is immutable while the
live log continues to append.

No prompt, assistant prose, command body, tool result, raw path, session id,
workspace title, or home-directory segment is included.

## Claude contradiction corpus

| Observation | Count |
|---|---:|
| source files scanned | ${String(params.claude.filesScanned)} |
| direct tool paths inside grid worktree | ${String(params.claude.directGridToolPaths)} |
| assistant envelopes: grid cwd + main branch | ${String(claudeCounts['assistant:grid-cwd:main-branch'] ?? 0)} |
| user envelopes: grid cwd + main branch | ${String(claudeCounts['user:grid-cwd:main-branch'] ?? 0)} |

The minimized fixture keeps two real assistant records: one whose envelope cwd
is main while its direct tool path is in the grid worktree, and one whose cwd
and tool path are in the grid worktree while its branch remains main.

## Codex 0.151 complaint-time rollout

| Command location/status | Count |
|---|---:|
${Object.entries(codexCounts).map(([key, count]) => `| \`${key}\` | ${String(count)} |`).join('\n')}

The final ${String(params.codex.completedTail)} completed commands all identify
the UI worktree. The matching session metadata identifies Codex
${String(params.codex.cliVersion)} and the main launch checkout.

## Per-session proxy exact identity

| Observation | Count |
|---|---:|
| fixed request prefix | ${String(params.proxy.fixedRequestPrefix)} |
| zstd bodies | ${String(params.proxy.zstdBodies)} |
| successfully decoded JSON bodies | ${String(params.proxy.parsedBodies)} |
| thread id matches rollout | ${String(params.proxy.threadMatches)} |
| session id matches rollout | ${String(params.proxy.sessionMatches)} |
| thread id equals session id | ${String(params.proxy.equalThreadAndSession)} |
| current \`request_shape\` present | ${String(params.proxy.requestShapePresent)} |
| unique thread ids | ${String(params.proxy.uniqueThreadIds)} |

## Live Agent Code delivery gap

| Recorded channel | Count through cutoff |
|---|---:|
${Object.entries(channels).map(([key, count]) => `| \`${key}\` | ${String(count)} |`).join('\n')}

The recording contains zero \`session:jsonl-entries\`, both workspace and
recording metadata have no provider session id, and startup records the exact
\`unsupported-cli\` prompt-evidence refusal. The provider rollout therefore
exists and parses correctly but never enters the live renderer path.

## Conclusions that constrain implementation

1. Git must own branch identity after a path matches a worktree; the observed
   Claude provider branch remains main after real worktree activity.
2. A direct tool path must outrank generic cwd metadata from the same Claude
   envelope.
3. The Codex parser is not the current live failure. Its authoritative records
   are absent from SessionFeed because rollout ownership was never acquired.
4. The private per-session proxy already exposes an exact provider id that is
   independently confirmed by the rollout filename and \`session_meta.id\`.
5. Current proxy request-shape extraction sees none of the recorded compressed
   bodies, so exact identity must be projected content-safely before it can
   participate in existing rollout ownership.
`
}

function manifestMarkdown(fixtures: Array<{ name: string; fingerprint: string }>): string {
  return `# Live worktree attribution fixtures

Generated by \`scripts/extract-worktree-live-attribution-fixtures.mts\` at fixed
cutoff \`${CUTOFF}\`. Do not hand-edit.

| Fixture | Source fingerprint |
|---|---|
${fixtures.map(item => `| \`${item.name}\` | \`${item.fingerprint}\` |`).join('\n')}

## Privacy and provenance

- Fingerprints are truncated SHA-256 values over selected raw records; source
  filenames and provider/app session ids are intentionally not published.
- Paths preserve only main/worktree/descendant topology under \`/fixture/\`.
- Branches and identities are deterministic tokens shared across fixtures.
- Claude fixtures retain only the direct tool discriminator and path-bearing
  input field; all prompt, prose, and unrelated tool content is discarded.
- Codex commands become length-carrying placeholders. No command bytes survive.
- The proxy fixture retains real zstd transport and \`client_metadata\` nesting,
  but the body is minimized, tokenized, and deterministically recompressed.
- The live-gap fixture stores only channel/kind counts plus the two structural
  startup events. Screen, semantic, and feed payloads are never emitted.
- Every output passes the canonical sensitive-value scanner, a UUID/home-path
  rejection gate, and a strict string allowlist before writing.
`
}

function assertNoPrivateText(value: string, label: string): void {
  const username = basename(HOME)
  if (value.includes(HOME) || value.includes(username)) {
    throw new Error(`refusing ${label}: operator home or username survived`)
  }
  if (UUID.test(value)) {
    throw new Error(`refusing ${label}: UUID-shaped identity survived`)
  }
}

async function verifyCheckedInArtifacts(): Promise<void> {
  // WHY checked-in verification is a first-class mode rather than a fallback
  // inside extraction: the raw proxy and session recordings are private,
  // retention-managed runtime artifacts. Once their pane is restarted, Agent
  // Code may rotate those directories. Silently treating committed fixtures as
  // extraction inputs would then be circular evidence. This mode verifies the
  // durable claims that remain independently checkable (privacy, canonical
  // serialization, manifest fingerprints, and exact zstd transport bytes),
  // while default extraction still fails if the original source has vanished.
  const outputs: Array<{ name: string; value: JsonRecord }> = []
  for (const name of FIXTURE_NAMES) {
    const path = join(FIXTURE_DIR, name)
    const raw = await readFile(path, 'utf8')
    const value = asRecord(JSON.parse(raw))
    if (!value) throw new Error(`${name} is not a JSON object`)
    if (raw !== `${JSON.stringify(value, null, 2)}\n`) {
      throw new Error(`${name} is not canonically serialized`)
    }
    assertPublishable(value, name)
    outputs.push({ name, value })
  }

  const proxy = outputs.find(output => (
    output.name === 'codex-proxy-exact-identity-zstd.json'
  ))?.value
  const event = asRecord(proxy?.event)
  const expected = asRecord(proxy?.expected)
  const decoded = event ? decodeProxyBody(event) : null
  const expectedBody = {
    client_metadata: {
      thread_id: stringField(expected, 'threadId'),
      session_id: stringField(expected, 'sessionId'),
      root_turn_id: stringField(expected, 'rootTurnId'),
    },
  }
  if (
    decoded?.encoding !== 'zstd' ||
    JSON.stringify(decoded.body) !== JSON.stringify(expectedBody)
  ) {
    throw new Error('checked-in proxy body does not preserve only the expected identity')
  }
  const deterministicBody = zstd.zstdCompressSync(
    Buffer.from(JSON.stringify(expectedBody)),
  ).toString('base64')
  if (deterministicBody !== stringField(event, 'body_b64')) {
    throw new Error('checked-in proxy body is not the deterministic minimized zstd frame')
  }

  const manifestPath = join(FIXTURE_DIR, 'MANIFEST.md')
  const manifest = await readFile(manifestPath, 'utf8')
  const expectedManifest = manifestMarkdown(outputs.map(output => ({
    name: output.name,
    fingerprint: String(asRecord(output.value.$fixture)?.sourceFingerprint),
  })))
  if (manifest !== expectedManifest) {
    throw new Error('checked-in fixture manifest does not match fixture fingerprints')
  }
  const census = await readFile(join(EVIDENCE_DIR, 'shape-census.md'), 'utf8')
  assertNoPrivateText(manifest, 'fixture manifest')
  assertNoPrivateText(census, 'shape census')

  console.log(`Checked-in fixture verification passed (${String(outputs.length)} fixtures)`)
}

async function main(): Promise<void> {
  const git = await selectedGitIdentities()
  const tokens = new Tokenizer(git)
  const claude = await collectClaude(git, tokens)
  const codex = await collectCodex(git, tokens)
  const liveSession = await locateLiveSession(git, codex.providerId)
  const proxy = await collectProxy(liveSession.proxyFile, codex.providerId, tokens)
  const live = await collectLiveGap(liveSession, tokens)
  const gitOutput = gitFixture(git, tokens)

  const outputs: Array<{ name: typeof FIXTURE_NAMES[number]; value: JsonRecord }> = [
    { name: FIXTURE_NAMES[0], value: claude.fixture },
    { name: FIXTURE_NAMES[1], value: codex.fixture },
    { name: FIXTURE_NAMES[2], value: proxy.fixture },
    { name: FIXTURE_NAMES[3], value: live.fixture },
    { name: FIXTURE_NAMES[4], value: gitOutput },
  ]
  for (const output of outputs) assertPublishable(output.value, output.name)

  await mkdir(FIXTURE_DIR, { recursive: true })
  await mkdir(EVIDENCE_DIR, { recursive: true })
  for (const output of outputs) {
    await writeJson(join(FIXTURE_DIR, output.name), output.value)
  }
  await writeFile(
    join(EVIDENCE_DIR, 'shape-census.md'),
    censusMarkdown({
      claude: claude.census,
      codex: codex.census,
      proxy: proxy.census,
      live: live.census,
    }),
    'utf8',
  )
  await writeFile(
    join(FIXTURE_DIR, 'MANIFEST.md'),
    manifestMarkdown(outputs.map(output => ({
      name: output.name,
      fingerprint: String(asRecord(output.value.$fixture)?.sourceFingerprint),
    }))),
    'utf8',
  )

  console.log(`Claude files scanned: ${String(claude.census.filesScanned)}`)
  console.log(`Codex files scanned: ${String(codex.census.filesScanned)}`)
  console.log(`Proxy request prefix: ${String(proxy.census.fixedRequestPrefix)}`)
  console.log(`Fixtures written: ${FIXTURE_DIR}`)
  console.log(`Census written: ${join(EVIDENCE_DIR, 'shape-census.md')}`)
}

const args = process.argv.slice(2)
if (args.length === 0) await main()
else if (args.length === 1 && args[0] === '--verify-checked-in') {
  await verifyCheckedInArtifacts()
} else {
  throw new Error(`unsupported arguments: ${args.join(' ')}`)
}
