import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import type {
  AgentCodeInstalledSkillFileRecord,
  AgentCodeInstalledSkillSource,
} from '@shared/types/agentCodeConventions.js'
import {
  AGENT_CODE_INSTALLED_SKILL_MAX_FILES,
  AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_DISCOVERY_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_SKILL_MD_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH,
  isSafeAgentCodeInstalledSkillPath,
  type AgentCodeInstalledSkillCandidate,
} from '@shared/types/agentCodeInstalledSkills.js'

const MAX_CANDIDATES = 100
const MAX_GIT_TEXT_BYTES = 4 * 1024 * 1024
const PORTABLE_FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
])

export type StagedInstalledSkillCandidate = {
  candidate: AgentCodeInstalledSkillCandidate
  snapshotDigest: string
  contents: Map<string, Buffer>
}

export type GitHubSkillDiscoveryPayload = {
  repositoryUrl: string
  requestedRef: string
  resolvedCommit: string
  candidates: StagedInstalledSkillCandidate[]
  notices: string[]
}

export type ParsedGitHubSkillUrl = {
  owner: string
  repository: string
  repositoryUrl: string
  treeSegments: string[]
}

type GitTreeEntry = {
  mode: string
  type: string
  object: string
  path: string
}

type ResolvedGitHubSource = ParsedGitHubSkillUrl & {
  requestedRef: string
  requestedPath: string
}

type GitRunner = (
  args: string[],
  options: { cwd?: string; maxBuffer?: number; binary?: boolean; environment: NodeJS.ProcessEnv },
) => Promise<string | Buffer>

export type GitHubSkillSourceOptions = {
  runGit?: GitRunner
}

/**
 * Acquires public GitHub repositories without checking repository content out.
 *
 * WHY a bare object database is the trust boundary: a normal checkout can
 * consult repository-controlled attributes, create symlinks, and hand package
 * paths to later filesystem code before validation. `ls-tree` plus `cat-file`
 * keeps every path and mode inert data until this module has bounded and
 * classified it.
 */
export class GitHubSkillSource {
  private readonly runGit: GitRunner

  constructor(options: GitHubSkillSourceOptions = {}) {
    this.runGit = options.runGit ?? runGitProcess
  }

  async discover(inputUrl: string): Promise<GitHubSkillDiscoveryPayload> {
    const parsed = parseGitHubSkillUrl(inputUrl)
    const scratch = await mkdtemp(join(tmpdir(), 'agent-code-skill-source-'))
    const bareRepository = join(scratch, 'repository.git')
    const emptyGitConfig = join(scratch, 'empty.gitconfig')
    const emptyHooks = join(scratch, 'hooks')
    await writeFile(emptyGitConfig, '', { mode: 0o600 })
    await mkdir(emptyHooks, { mode: 0o700 })
    const environment = isolatedGitEnvironment(emptyGitConfig)

    try {
      const resolved = await this.resolveSource(parsed, environment)
      await this.gitText([
        '-c', 'credential.helper=',
        '-c', `core.hooksPath=${emptyHooks}`,
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        // WHY partial clone matters even though every selected blob is bounded
        // later: a repository can contain enormous unrelated history or files.
        // Deferring blob transfer keeps the acquisition boundary proportional
        // to the package the user is actually reviewing.
        'clone', '--bare', '--filter=blob:none', '--depth=1', '--single-branch',
        '--branch', resolved.requestedRef,
        `${resolved.repositoryUrl}.git`, bareRepository,
      ], { environment })
      const resolvedCommit = (await this.gitText([
        '-C', bareRepository, 'rev-parse', 'HEAD^{commit}',
      ], { environment })).trim()
      if (!/^[a-f0-9]{40}$/.test(resolvedCommit)) {
        throw new GitHubSkillSourceError('network', 'GitHub returned an invalid commit identity.')
      }
      const treeText = await this.gitText([
        '-C', bareRepository, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD',
      ], { environment, maxBuffer: MAX_GIT_TEXT_BYTES })
      const tree = parseGitTree(treeText)
      return await this.discoverCandidates({
        resolved,
        resolvedCommit,
        tree,
        bareRepository,
        environment,
      })
    } catch (error) {
      throw classifyGitHubSkillSourceError(error)
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async resolveSource(
    parsed: ParsedGitHubSkillUrl,
    environment: NodeJS.ProcessEnv,
  ): Promise<ResolvedGitHubSource> {
    const remote = `${parsed.repositoryUrl}.git`
    const refs = await this.gitText([
      '-c', 'credential.helper=',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      'ls-remote', '--symref', remote, 'HEAD', 'refs/heads/*', 'refs/tags/*',
    ], { environment })
    const advertised = parseAdvertisedRefs(refs)
    if (!advertised.defaultBranch) {
      throw new GitHubSkillSourceError('not-found', 'The repository has no discoverable default branch.')
    }
    if (parsed.treeSegments.length === 0) {
      if (advertised.defaultBranch.length > 512) {
        throw new GitHubSkillSourceError('validation', 'The default GitHub branch name is too long.')
      }
      return {
        ...parsed,
        requestedRef: advertised.defaultBranch,
        requestedPath: '',
      }
    }

    let requestedRef: string | null = null
    let refSegmentCount = 0
    for (let length = parsed.treeSegments.length; length >= 1; length -= 1) {
      const candidate = parsed.treeSegments.slice(0, length).join('/')
      if (!advertised.refs.has(candidate)) continue
      requestedRef = candidate
      refSegmentCount = length
      break
    }
    if (!requestedRef) {
      throw new GitHubSkillSourceError(
        'not-found',
        'The GitHub tree URL does not begin with an advertised branch or tag.',
      )
    }
    if (requestedRef.length > 512) {
      throw new GitHubSkillSourceError('validation', 'The GitHub branch or tag name is too long.')
    }
    const requestedPath = parsed.treeSegments.slice(refSegmentCount).join('/')
    if (requestedPath && !isSafeRepositoryPath(requestedPath)) {
      throw new GitHubSkillSourceError('validation', 'The GitHub directory path is unsafe.')
    }
    return { ...parsed, requestedRef, requestedPath }
  }

  private async discoverCandidates(input: {
    resolved: ResolvedGitHubSource
    resolvedCommit: string
    tree: GitTreeEntry[]
    bareRepository: string
    environment: NodeJS.ProcessEnv
  }): Promise<GitHubSkillDiscoveryPayload> {
    const { resolved, resolvedCommit, tree, bareRepository, environment } = input
    const requestedPrefix = resolved.requestedPath ? `${resolved.requestedPath}/` : ''
    const exactSkillPath = `${requestedPrefix}SKILL.md`
    const exact = tree.some(entry => entry.path === exactSkillPath)
    const skillPaths = exact
      ? [exactSkillPath]
      : tree
          .filter(entry => entry.path.startsWith(requestedPrefix)
            && entry.path.endsWith('/SKILL.md'))
          .map(entry => entry.path)
          .sort()
    if (skillPaths.length === 0) {
      throw new GitHubSkillSourceError(
        'not-found',
        resolved.requestedPath
          ? 'No SKILL.md package exists at or below that GitHub directory.'
          : 'No Agent Skills packages were found in that repository.',
      )
    }
    if (skillPaths.length > MAX_CANDIDATES) {
      throw new GitHubSkillSourceError(
        'validation',
        `The source contains more than ${MAX_CANDIDATES} candidate skills. Use a narrower GitHub directory URL.`,
      )
    }

    const roots = skillPaths.map(path => dirnamePosix(path))
    for (const root of roots) {
      const nested = roots.find(other => other !== root && isWithinRepositoryPath(other, root))
      if (nested) {
        throw new GitHubSkillSourceError(
          'validation',
          `Nested skill packages at ${displayRoot(root)} and ${displayRoot(nested)} are ambiguous. Use a direct directory URL.`,
        )
      }
    }

    const candidates: StagedInstalledSkillCandidate[] = []
    const notices: string[] = []
    let discoveryBytes = 0
    for (const root of roots) {
      let candidate: StagedInstalledSkillCandidate
      try {
        candidate = await this.readCandidate({
          root,
          resolved,
          resolvedCommit,
          tree,
          bareRepository,
          environment,
        })
      } catch (error) {
        const classified = classifyGitHubSkillSourceError(error)
        if (roots.length === 1) throw classified
        notices.push(`${displayRoot(root)} was skipped: ${classified.message}`)
        continue
      }
      discoveryBytes += candidate.candidate.totalBytes
      if (discoveryBytes > AGENT_CODE_INSTALLED_SKILL_MAX_DISCOVERY_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `The discovery exceeds ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_DISCOVERY_BYTES)}. Use a narrower GitHub directory URL.`,
        )
      }
      candidates.push(candidate)
    }
    if (candidates.length === 0) {
      throw new GitHubSkillSourceError(
        'validation',
        notices[0] ?? 'No valid Agent Skills packages were found.',
      )
    }
    const duplicateNames = duplicateValues(candidates.map(value => value.candidate.name))
    if (duplicateNames.length > 0) {
      throw new GitHubSkillSourceError(
        'validation',
        `The source contains duplicate skill name${duplicateNames.length === 1 ? '' : 's'}: ${duplicateNames.join(', ')}.`,
      )
    }
    return {
      repositoryUrl: resolved.repositoryUrl,
      requestedRef: resolved.requestedRef,
      resolvedCommit,
      candidates,
      notices,
    }
  }

  private async readCandidate(input: {
    root: string
    resolved: ResolvedGitHubSource
    resolvedCommit: string
    tree: GitTreeEntry[]
    bareRepository: string
    environment: NodeJS.ProcessEnv
  }): Promise<StagedInstalledSkillCandidate> {
    const { root, resolved, resolvedCommit, tree, bareRepository, environment } = input
    const entries = tree
      .filter(entry => root === '' || isWithinRepositoryPath(entry.path, root))
      .map(entry => ({ ...entry, relativePath: root === '' ? entry.path : entry.path.slice(root.length + 1) }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    if (entries.length === 0 || entries.length > AGENT_CODE_INSTALLED_SKILL_MAX_FILES) {
      throw new GitHubSkillSourceError(
        'validation',
        `A skill package must contain 1–${AGENT_CODE_INSTALLED_SKILL_MAX_FILES} files.`,
      )
    }
    for (const entry of entries) {
      if (!isSafeRepositoryPath(entry.relativePath)) {
        throw new GitHubSkillSourceError('validation', `Unsafe package path: ${entry.relativePath}`)
      }
      if (entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') {
        throw new GitHubSkillSourceError(
          'validation',
          `Links and submodules are not supported inside skills (${entry.relativePath}).`,
        )
      }
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        throw new GitHubSkillSourceError(
          'validation',
          `Unsupported Git file mode ${entry.mode} at ${entry.relativePath}.`,
        )
      }
    }

    const contents = new Map<string, Buffer>()
    const files: AgentCodeInstalledSkillFileRecord[] = []
    let totalBytes = 0
    for (const entry of entries) {
      const content = await this.gitBuffer([
        '-C', bareRepository, 'cat-file', 'blob', entry.object,
      ], { environment, maxBuffer: AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES + 1 })
      if (content.byteLength > AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `${entry.relativePath} exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)} per-file limit.`,
        )
      }
      totalBytes += content.byteLength
      if (totalBytes > AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `The package exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES)} total limit.`,
        )
      }
      const sha256 = sha256Buffer(content)
      contents.set(entry.relativePath, content)
      files.push({
        path: entry.relativePath,
        bytes: content.byteLength,
        sha256,
        executable: entry.mode === '100755',
      })
    }

    const skillBytes = contents.get('SKILL.md')
    if (!skillBytes) throw new GitHubSkillSourceError('validation', 'The package has no root SKILL.md.')
    if (skillBytes.byteLength > AGENT_CODE_INSTALLED_SKILL_MAX_SKILL_MD_BYTES) {
      throw new GitHubSkillSourceError(
        'validation',
        `SKILL.md exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_SKILL_MD_BYTES)} limit.`,
      )
    }
    const skillText = decodeUtf8(skillBytes, 'SKILL.md')
    const frontmatter = parseSkillFrontmatter(skillText)
    // Git tree paths are always POSIX paths, even when Agent Code runs on
    // Windows. Host-path basename would misread a repository path there.
    const directoryName = root === '' ? resolved.repository : posix.basename(root)
    if (directoryName !== frontmatter.name) {
      throw new GitHubSkillSourceError(
        'validation',
        `SKILL.md name ${JSON.stringify(frontmatter.name)} must match directory ${JSON.stringify(directoryName)}.`,
      )
    }

    const warnings: string[] = []
    const executableFiles = files.filter(file => file.executable).map(file => file.path)
    if (executableFiles.length > 0) {
      warnings.push(summarizeValues(
        `Contains ${executableFiles.length} executable file${executableFiles.length === 1 ? '' : 's'}`,
        executableFiles,
      ))
    }
    const providerFiles = files.map(file => file.path).filter(isProviderSpecificPath)
    if (providerFiles.length > 0) {
      warnings.push(summarizeValues('Contains provider-specific metadata', providerFiles))
    }
    const extraFields = frontmatter.fields.filter(field => !PORTABLE_FRONTMATTER_FIELDS.has(field))
    if (extraFields.length > 0) {
      warnings.push(summarizeValues('Uses unrecognized frontmatter fields', extraFields))
    }

    const snapshotDigest = packageDigest(files)
    const sourcePath = root
    const skillUrl = `${resolved.repositoryUrl}/tree/${encodeGitHubPath(resolved.requestedRef)}${
      sourcePath ? `/${encodeGitHubPath(sourcePath)}` : ''
    }`
    if (skillUrl.length > AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH) {
      throw new GitHubSkillSourceError(
        'validation',
        'The resolved GitHub ref or skill URL is too long to store safely.',
      )
    }
    const source: AgentCodeInstalledSkillSource = {
      owner: resolved.owner,
      repository: resolved.repository,
      repositoryUrl: resolved.repositoryUrl,
      requestedRef: resolved.requestedRef,
      path: sourcePath,
      skillUrl,
      resolvedCommit,
    }
    const candidate: AgentCodeInstalledSkillCandidate = {
      candidateId: sha256Text(`${resolved.owner}/${resolved.repository}\0${resolvedCommit}\0${root}\0${snapshotDigest}`).slice(0, 32),
      name: frontmatter.name,
      description: frontmatter.description,
      source,
      files,
      totalBytes,
      warnings,
    }
    return { candidate, snapshotDigest, contents }
  }

  private async gitText(
    args: string[],
    options: { environment: NodeJS.ProcessEnv; maxBuffer?: number },
  ): Promise<string> {
    const result = await this.runGit(args, {
      environment: options.environment,
      maxBuffer: options.maxBuffer ?? MAX_GIT_TEXT_BYTES,
    })
    if (typeof result !== 'string') return decodeUtf8(result, 'Git output')
    return result
  }

  private async gitBuffer(
    args: string[],
    options: { environment: NodeJS.ProcessEnv; maxBuffer: number },
  ): Promise<Buffer> {
    const result = await this.runGit(args, {
      environment: options.environment,
      maxBuffer: options.maxBuffer,
      binary: true,
    })
    return typeof result === 'string' ? Buffer.from(result) : result
  }
}

export class GitHubSkillSourceError extends Error {
  constructor(
    readonly code: 'validation' | 'not-found' | 'git-unavailable' | 'network' | 'io-error',
    message: string,
  ) {
    super(message)
    this.name = 'GitHubSkillSourceError'
  }
}

export function parseGitHubSkillUrl(input: string): ParsedGitHubSkillUrl {
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH) {
    throw new GitHubSkillSourceError('validation', 'Enter a bounded GitHub repository URL.')
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new GitHubSkillSourceError('validation', 'Enter a valid GitHub HTTPS URL.')
  }
  if (url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'github.com'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new GitHubSkillSourceError(
      'validation',
      'Only public https://github.com repository and directory URLs are supported.',
    )
  }
  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  } catch {
    throw new GitHubSkillSourceError('validation', 'The GitHub URL contains invalid escaping.')
  }
  if (segments.length < 2) {
    throw new GitHubSkillSourceError('validation', 'The GitHub URL must include an owner and repository.')
  }
  const owner = segments[0]!
  const repository = segments[1]!.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new GitHubSkillSourceError('validation', 'The GitHub owner or repository name is invalid.')
  }
  let treeSegments: string[] = []
  if (segments.length > 2) {
    if (segments[2] !== 'tree' || segments.length < 4) {
      throw new GitHubSkillSourceError(
        'validation',
        'Use a repository URL or a GitHub /tree/<ref>/<directory> URL.',
      )
    }
    treeSegments = segments.slice(3)
    if (treeSegments.some(segment => !isSafeGitHubTreeSegment(segment))) {
      throw new GitHubSkillSourceError('validation', 'The GitHub tree path is unsafe.')
    }
  }
  const repositoryUrl = `https://github.com/${owner}/${repository}`
  return { owner, repository, repositoryUrl, treeSegments }
}

export function parseSkillFrontmatter(text: string): {
  name: string
  description: string
  fields: string[]
} {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') {
    throw new GitHubSkillSourceError('validation', 'SKILL.md must begin with YAML frontmatter.')
  }
  const end = lines.indexOf('---', 1)
  if (end < 0) {
    throw new GitHubSkillSourceError('validation', 'SKILL.md frontmatter has no closing delimiter.')
  }
  const values = new Map<string, string>()
  const seenFields = new Set<string>()
  const fields: string[] = []
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) {
      throw new GitHubSkillSourceError(
        'validation',
        'SKILL.md frontmatter must use top-level scalar fields.',
      )
    }
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line)
    if (!match) {
      throw new GitHubSkillSourceError('validation', `Unsupported YAML frontmatter at line ${index + 1}.`)
    }
    const key = match[1]!
    if (seenFields.has(key)) {
      throw new GitHubSkillSourceError('validation', `SKILL.md repeats frontmatter field ${key}.`)
    }
    seenFields.add(key)
    let scalar = match[2] ?? ''
    const requiredScalar = key === 'name' || key === 'description'
    if (/^[>|][+-]?$/.test(scalar) && requiredScalar) {
      const folded = scalar.startsWith('>')
      const block: string[] = []
      while (index + 1 < end && (/^\s/.test(lines[index + 1]!) || lines[index + 1] === '')) {
        index += 1
        block.push(lines[index]!.replace(/^ {1,2}/, ''))
      }
      scalar = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim()
      values.set(key, scalar)
    } else if (requiredScalar) {
      scalar = parseYamlScalar(scalar, index + 1)
      values.set(key, scalar)
    } else if (scalar.trim() === '' || /^[>|][+-]?$/.test(scalar)) {
      // WHY this parser deliberately does not interpret nested metadata: only
      // name and description affect Agent Code's identity/UI. Standard skills
      // commonly use mappings or sequences for metadata and tool declarations;
      // rejecting those would make the importer less portable, while parsing
      // them would create an unnecessary YAML execution/complexity surface.
      while (index + 1 < end && (/^\s/.test(lines[index + 1]!) || lines[index + 1] === '')) {
        index += 1
      }
    }
    fields.push(key)
  }
  const name = values.get('name') ?? ''
  const description = values.get('description') ?? ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    || name.length > 64
    || !isSafeAgentCodeInstalledSkillPath(name)) {
    throw new GitHubSkillSourceError('validation', 'SKILL.md has an invalid portable skill name.')
  }
  if (description.length === 0 || description.length > 1_024 || /[\r\n\0]/.test(description)) {
    throw new GitHubSkillSourceError('validation', 'SKILL.md has an invalid portable description.')
  }
  return { name, description, fields: fields.sort() }
}

function parseYamlScalar(value: string, line: number): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new GitHubSkillSourceError('validation', `Unterminated YAML string at line ${line}.`)
    }
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'string') return parsed
    } catch {
      // Fall through to the single actionable scalar error below.
    }
    throw new GitHubSkillSourceError('validation', `Invalid quoted YAML string at line ${line}.`)
  }
  const comment = trimmed.search(/\s+#/)
  const plain = comment >= 0 ? trimmed.slice(0, comment).trimEnd() : trimmed
  if (plain === '' || plain.startsWith('[') || plain.startsWith('{')
    || plain.startsWith('&') || plain.startsWith('*') || plain.startsWith('!')) {
    throw new GitHubSkillSourceError(
      'validation',
      `Frontmatter line ${line} must contain a plain or quoted string.`,
    )
  }
  return plain
}

function parseAdvertisedRefs(text: string): { defaultBranch: string | null; refs: Set<string> } {
  const refs = new Set<string>()
  let defaultBranch: string | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD')) {
      defaultBranch = line.slice('ref: refs/heads/'.length, -'\tHEAD'.length)
      refs.add(defaultBranch)
      continue
    }
    const match = /^[a-f0-9]{40}\trefs\/(heads|tags)\/(.+?)(?:\^\{\})?$/.exec(line)
    if (match) refs.add(match[2]!)
  }
  return { defaultBranch, refs }
}

function parseGitTree(text: string): GitTreeEntry[] {
  const entries: GitTreeEntry[] = []
  for (const record of text.split('\0')) {
    if (!record) continue
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(record)
    if (!match || !isSafeRepositoryPath(match[4]!)) {
      throw new GitHubSkillSourceError('validation', 'The repository contains an unsafe Git tree entry.')
    }
    entries.push({ mode: match[1]!, type: match[2]!, object: match[3]!, path: match[4]! })
  }
  return entries
}

function packageDigest(files: AgentCodeInstalledSkillFileRecord[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.sha256)
    hash.update('\0')
    hash.update(file.executable ? '1' : '0')
    hash.update('\0')
  }
  return hash.digest('hex')
}

function isSafeRepositoryPath(path: string): boolean {
  return isSafeAgentCodeInstalledSkillPath(path)
}

function isSafeGitHubTreeSegment(segment: string): boolean {
  // These segments include the as-yet-unresolved ref, so filesystem-specific
  // restrictions belong only to `requestedPath` after longest-ref resolution.
  return segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('/')
    && !segment.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(segment)
}

function isWithinRepositoryPath(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`)
}

function dirnamePosix(path: string): string {
  const value = posix.dirname(path)
  return value === '.' ? '' : value
}

function displayRoot(root: string): string {
  return root || 'repository root'
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function isProviderSpecificPath(path: string): boolean {
  return path === 'agents/openai.yaml'
    || path === '.codex-plugin/plugin.json'
    || path === '.claude-plugin/plugin.json'
    || path.startsWith('hooks/')
}

function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new GitHubSkillSourceError('validation', `${label} is not valid UTF-8.`)
  }
}

function isolatedGitEnvironment(emptyGitConfig: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_CONFIG_') || [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_EXEC_PATH',
    ].includes(key)) delete environment[key]
  }
  // WHY inherited Git repository/config variables are removed: Agent Code may
  // itself be launched from a shell with temporary Git plumbing variables.
  // Letting those variables redirect object storage or inject `-c` entries
  // would make acquisition depend on ambient state instead of the hardened
  // command assembled above.
  environment.GIT_CONFIG_GLOBAL = emptyGitConfig
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GCM_INTERACTIVE = 'never'
  return environment
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`
}

function summarizeValues(prefix: string, values: string[]): string {
  const limit = 1_800
  let message = `${prefix}: `
  let included = 0
  for (const value of values) {
    const addition = `${included === 0 ? '' : ', '}${value}`
    if (message.length + addition.length + 32 > limit) break
    message += addition
    included += 1
  }
  const omitted = values.length - included
  if (omitted > 0) message += `${included === 0 ? '' : ','} …and ${omitted} more`
  return `${message}.`
}

function classifyGitHubSkillSourceError(error: unknown): GitHubSkillSourceError {
  if (error instanceof GitHubSkillSourceError) return error
  const nodeError = error as NodeJS.ErrnoException & { stderr?: string | Buffer }
  if (nodeError.code === 'ENOENT') {
    return new GitHubSkillSourceError('git-unavailable', 'Git is required to inspect GitHub skills.')
  }
  const detail = Buffer.isBuffer(nodeError.stderr)
    ? nodeError.stderr.toString('utf8')
    : nodeError.stderr
  if (typeof detail === 'string' && /not found|repository.*does not exist|couldn.t find remote ref/i.test(detail)) {
    return new GitHubSkillSourceError('not-found', 'The public GitHub repository or ref was not found.')
  }
  if (typeof detail === 'string' && /authentication|could not read username|terminal prompts disabled/i.test(detail)) {
    return new GitHubSkillSourceError('not-found', 'Private GitHub repositories are not supported yet.')
  }
  if (typeof detail === 'string' && /could not resolve|failed to connect|timed out|network/i.test(detail)) {
    return new GitHubSkillSourceError('network', 'Could not reach GitHub to inspect that skill source.')
  }
  return new GitHubSkillSourceError(
    'io-error',
    error instanceof Error && error.message ? error.message : 'Could not inspect the GitHub skill source.',
  )
}

function runGitProcess(
  args: string[],
  options: { cwd?: string; maxBuffer?: number; binary?: boolean; environment: NodeJS.ProcessEnv },
): Promise<string | Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, {
      cwd: options.cwd,
      env: options.environment,
      encoding: options.binary ? 'buffer' : 'utf8',
      maxBuffer: options.maxBuffer ?? MAX_GIT_TEXT_BYTES,
      timeout: 60_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stderr })
        reject(error)
        return
      }
      resolvePromise(stdout)
    })
  })
}
