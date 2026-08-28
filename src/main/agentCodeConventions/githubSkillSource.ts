import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { dirname, posix } from 'node:path'
import { parseDocument } from 'yaml'

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
  compareAgentCodeInstalledSkillPaths,
  findAgentCodeInstalledSkillPathCollision,
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
  requestedRefType: GitRefType
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
  size?: number
}

type ResolvedGitHubSource = ParsedGitHubSkillUrl & {
  requestedRef: string
  requestedRefType: GitRefType
  requestedCommit: string
  requestedPath: string
}

type GitRefType = 'branch' | 'tag'

type AdvertisedGitRef = {
  name: string
  type: GitRefType
  commit: string
}

type GitRunner = (
  args: string[],
  options: { cwd?: string; maxBuffer?: number; binary?: boolean; environment: NodeJS.ProcessEnv },
) => Promise<string | Buffer>

type HttpRunner = (url: string, maxBytes: number) => Promise<Buffer>

export type GitHubSkillSourceOptions = {
  runGit?: GitRunner
  fetchBytes?: HttpRunner
}

/**
 * Acquires selected public GitHub package bytes without cloning a repository.
 *
 * WHY ref resolution and content acquisition use separate transports: Git's
 * public advertisement is the reliable source for slash-containing branch/tag
 * identity, but even a bare clone lets repository-controlled packfiles cross a
 * disk limit before a watcher can cancel it. GitHub's recursive tree response
 * and raw commit URLs can instead be bounded in memory before any package byte
 * becomes durable. Blob object IDs bind those two responses to the exact
 * advertised commit that the user reviews.
 */
export class GitHubSkillSource {
  private readonly runGit: GitRunner
  private readonly fetchBytes: HttpRunner

  constructor(options: GitHubSkillSourceOptions = {}) {
    this.runGit = options.runGit ?? runGitProcess
    this.fetchBytes = options.fetchBytes ?? fetchBoundedGitHubBytes
  }

  async discover(inputUrl: string): Promise<GitHubSkillDiscoveryPayload> {
    const parsed = parseGitHubSkillUrl(inputUrl)
    const environment = isolatedGitEnvironment()

    try {
      const resolved = await this.resolveSource(parsed, environment)
      const tree = await this.readGitHubTree(resolved)
      return await this.discoverCandidates({
        resolved,
        resolvedCommit: resolved.requestedCommit,
        tree,
      })
    } catch (error) {
      throw classifyGitHubSkillSourceError(error)
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
    if (!advertised.defaultRef) {
      throw new GitHubSkillSourceError('not-found', 'The repository has no discoverable default branch.')
    }
    if (parsed.treeSegments.length === 0) {
      if (advertised.defaultRef.name.length > 512) {
        throw new GitHubSkillSourceError('validation', 'The default GitHub branch name is too long.')
      }
      return {
        ...parsed,
        requestedRef: advertised.defaultRef.name,
        requestedRefType: advertised.defaultRef.type,
        requestedCommit: advertised.defaultRef.commit,
        requestedPath: '',
      }
    }

    let requestedRef: AdvertisedGitRef | null = null
    let refSegmentCount = 0
    for (let length = parsed.treeSegments.length; length >= 1; length -= 1) {
      const candidate = parsed.treeSegments.slice(0, length).join('/')
      const identities = advertised.refs.get(candidate) ?? []
      if (identities.length === 0) continue
      if (identities.length > 1) {
        throw new GitHubSkillSourceError(
          'validation',
          `GitHub advertises both a branch and tag named ${JSON.stringify(candidate)}. Use an unambiguous source ref.`,
        )
      }
      requestedRef = identities[0]!
      refSegmentCount = length
      break
    }
    if (!requestedRef) {
      throw new GitHubSkillSourceError(
        'not-found',
        'The GitHub tree URL does not begin with an advertised branch or tag.',
      )
    }
    if (requestedRef.name.length > 512) {
      throw new GitHubSkillSourceError('validation', 'The GitHub branch or tag name is too long.')
    }
    const requestedPath = parsed.treeSegments.slice(refSegmentCount).join('/')
    if (requestedPath && !isSafeRepositoryPath(requestedPath)) {
      throw new GitHubSkillSourceError('validation', 'The GitHub directory path is unsafe.')
    }
    return {
      ...parsed,
      requestedRef: requestedRef.name,
      requestedRefType: requestedRef.type,
      requestedCommit: requestedRef.commit,
      requestedPath,
    }
  }

  private async discoverCandidates(input: {
    resolved: ResolvedGitHubSource
    resolvedCommit: string
    tree: GitTreeEntry[]
  }): Promise<GitHubSkillDiscoveryPayload> {
    const { resolved, resolvedCommit, tree } = input
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
      requestedRefType: resolved.requestedRefType,
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
  }): Promise<StagedInstalledSkillCandidate> {
    const { root, resolved, resolvedCommit, tree } = input
    const entries = tree
      .filter(entry => root === '' || isWithinRepositoryPath(entry.path, root))
      .map(entry => ({ ...entry, relativePath: root === '' ? entry.path : entry.path.slice(root.length + 1) }))
      .sort((left, right) => compareAgentCodeInstalledSkillPaths(left.relativePath, right.relativePath))
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
    const collision = findAgentCodeInstalledSkillPathCollision(
      entries.map(entry => entry.relativePath),
    )
    if (collision) {
      throw new GitHubSkillSourceError(
        'validation',
        `Package paths ${JSON.stringify(collision.left)} and ${JSON.stringify(collision.right)} collide on a supported filesystem.`,
      )
    }

    const contents = new Map<string, Buffer>()
    const files: AgentCodeInstalledSkillFileRecord[] = []
    let totalBytes = 0
    for (const entry of entries) {
      if (entry.size !== undefined && entry.size > AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `${entry.relativePath} exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)} per-file limit.`,
        )
      }
      const content = await this.fetchBytes(
        rawGitHubFileUrl(resolved, entry.path),
        AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES + 1,
      )
      if (content.byteLength > AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `${entry.relativePath} exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)} per-file limit.`,
        )
      }
      if (gitBlobObjectId(content) !== entry.object) {
        throw new GitHubSkillSourceError(
          'network',
          `GitHub returned bytes that do not match the reviewed commit tree (${entry.relativePath}).`,
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
      requestedRefType: resolved.requestedRefType,
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

  private async readGitHubTree(resolved: ResolvedGitHubSource): Promise<GitTreeEntry[]> {
    // WHY the recursive tree comes from GitHub's bounded JSON endpoint rather
    // than a local clone: Git writes packfiles directly to disk, so a polling
    // watcher can only notice a quota after repository-controlled bytes have
    // already crossed it. This response is rejected before more than the
    // bounded buffer is retained, and selected blobs are fetched separately.
    const treeUrl = `https://api.github.com/repos/${resolved.owner}/${resolved.repository}`
      + `/git/trees/${resolved.requestedCommit}?recursive=1`
    const bytes = await this.fetchBytes(treeUrl, MAX_GIT_TEXT_BYTES)
    return parseGitHubTreeResponse(decodeUtf8(bytes, 'GitHub tree response'))
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
  const document = parseDocument(lines.slice(1, end).join('\n'), {
    prettyErrors: false,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new GitHubSkillSourceError(
      'validation',
      `SKILL.md contains invalid YAML frontmatter: ${document.errors[0]!.message}`,
    )
  }
  let frontmatter: unknown
  try {
    // WHY the whole bounded document is materialized even though Agent Code
    // only consumes two fields: supported providers parse the whole YAML map.
    // Skipping nested metadata would let Settings report Active for bytes that
    // Codex rejects. Map output also avoids object-prototype key hazards.
    frontmatter = document.toJS({ mapAsMap: true, maxAliasCount: 0 })
  } catch (error) {
    throw new GitHubSkillSourceError(
      'validation',
      `SKILL.md contains unsafe YAML frontmatter: ${safeErrorMessage(error)}`,
    )
  }
  if (!(frontmatter instanceof Map)) {
    throw new GitHubSkillSourceError('validation', 'SKILL.md frontmatter must be a YAML mapping.')
  }
  const fields: string[] = []
  for (const key of frontmatter.keys()) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new GitHubSkillSourceError('validation', 'SKILL.md frontmatter keys must be portable strings.')
    }
    fields.push(key)
  }
  const name = frontmatter.get('name')
  const description = frontmatter.get('description')
  if (typeof name !== 'string' || typeof description !== 'string') {
    throw new GitHubSkillSourceError(
      'validation',
      'SKILL.md name and description must be YAML strings.',
    )
  }
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

function parseAdvertisedRefs(text: string): {
  defaultRef: AdvertisedGitRef | null
  refs: Map<string, AdvertisedGitRef[]>
} {
  const fullRefs = new Map<string, string>()
  let defaultFullRef: string | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD')) {
      defaultFullRef = line.slice('ref: '.length, -'\tHEAD'.length)
      continue
    }
    const match = /^([a-f0-9]{40})\t(refs\/(?:heads|tags)\/.+?)(\^\{\})?$/.exec(line)
    if (!match) continue
    // Annotated tag advertisements include both the tag object and a peeled
    // commit. The latter is the commit `HEAD^{commit}` will produce after
    // cloning, so it is the identity updates must pin.
    if (!fullRefs.has(match[2]!) || match[3]) fullRefs.set(match[2]!, match[1]!)
  }
  const refs = new Map<string, AdvertisedGitRef[]>()
  for (const [fullRef, commit] of fullRefs) {
    const branch = fullRef.startsWith('refs/heads/')
    const prefix = branch ? 'refs/heads/' : 'refs/tags/'
    const name = fullRef.slice(prefix.length)
    const identity: AdvertisedGitRef = { name, type: branch ? 'branch' : 'tag', commit }
    refs.set(name, [...(refs.get(name) ?? []), identity])
  }
  const defaultName = defaultFullRef?.startsWith('refs/heads/')
    ? defaultFullRef.slice('refs/heads/'.length)
    : null
  const defaultRef = defaultName
    ? refs.get(defaultName)?.find(value => value.type === 'branch') ?? null
    : null
  return { defaultRef, refs }
}

function parseGitHubTreeResponse(text: string): GitTreeEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GitHubSkillSourceError('network', 'GitHub returned an invalid repository tree.')
  }
  if (!isRecord(parsed) || parsed.truncated !== false || !Array.isArray(parsed.tree)) {
    throw new GitHubSkillSourceError(
      'validation',
      'The GitHub repository tree is too large or incomplete. Use a smaller repository.',
    )
  }
  const entries: GitTreeEntry[] = []
  const paths = new Set<string>()
  for (const value of parsed.tree) {
    if (!isRecord(value)
      || typeof value.path !== 'string'
      || !isSafeRepositoryPath(value.path)
      || typeof value.mode !== 'string'
      || typeof value.type !== 'string'
      || typeof value.sha !== 'string'
      || !/^[a-f0-9]{40}$/.test(value.sha)
      || paths.has(value.path)) {
      throw new GitHubSkillSourceError('validation', 'The repository contains an unsafe Git tree entry.')
    }
    paths.add(value.path)
    if (value.type === 'tree' && value.mode === '040000') continue
    if ((value.type !== 'blob' && value.type !== 'commit')
      || !['100644', '100755', '120000', '160000'].includes(value.mode)
      || (value.size !== undefined
        && (!Number.isSafeInteger(value.size) || Number(value.size) < 0))) {
      throw new GitHubSkillSourceError('validation', 'The repository contains an unsupported Git tree entry.')
    }
    entries.push({
      mode: value.mode,
      type: value.type,
      object: value.sha,
      path: value.path,
      size: value.size === undefined ? undefined : Number(value.size),
    })
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

function gitBlobObjectId(value: Buffer): string {
  return createHash('sha1')
    .update(`blob ${value.byteLength}\0`)
    .update(value)
    .digest('hex')
}

function rawGitHubFileUrl(resolved: ResolvedGitHubSource, path: string): string {
  return `https://raw.githubusercontent.com/${resolved.owner}/${resolved.repository}`
    + `/${resolved.requestedCommit}/${encodeGitHubPath(path)}`
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new GitHubSkillSourceError('validation', `${label} is not valid UTF-8.`)
  }
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
  ]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  // WHY this is an allowlist rather than a Git-variable denylist: askpass,
  // credential, TLS, proxy, repository, and future Git control variables all
  // change the trust boundary. Copying process.env and trying to enumerate
  // every dangerous spelling would silently regress when Git adds another.
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
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

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function fetchBoundedGitHubBytes(url: string, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:'
    || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) {
    throw new GitHubSkillSourceError('validation', 'Agent Code refused an unexpected download host.')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(parsed, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agent-code',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 404) {
      throw new GitHubSkillSourceError('not-found', 'The public GitHub repository content was not found.')
    }
    if (!response.ok) {
      throw new GitHubSkillSourceError(
        'network',
        `GitHub content acquisition failed with HTTP ${response.status}.`,
      )
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new GitHubSkillSourceError(
        'validation',
        `A GitHub response exceeds the ${formatBytes(maxBytes)} acquisition limit.`,
      )
    }
    if (!response.body) throw new GitHubSkillSourceError('network', 'GitHub returned no response body.')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const read = await reader.read()
      if (read.done) break
      total += read.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new GitHubSkillSourceError(
          'validation',
          `A GitHub response exceeds the ${formatBytes(maxBytes)} acquisition limit.`,
        )
      }
      chunks.push(Buffer.from(read.value))
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    if (error instanceof GitHubSkillSourceError) throw error
    if (controller.signal.aborted) {
      throw new GitHubSkillSourceError('network', 'GitHub content acquisition timed out.')
    }
    throw new GitHubSkillSourceError('network', safeErrorMessage(error))
  } finally {
    clearTimeout(timeout)
  }
}

function runGitProcess(
  args: string[],
  options: {
    cwd?: string
    maxBuffer?: number
    binary?: boolean
    environment: NodeJS.ProcessEnv
  },
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
