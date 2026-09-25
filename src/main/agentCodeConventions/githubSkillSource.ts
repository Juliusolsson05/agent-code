import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { posix } from 'node:path'
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
import type { SkillInstallGitHubSource } from '@shared/skills/installSource.js'

const MAX_GIT_TEXT_BYTES = 4 * 1024 * 1024
const PORTABLE_FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
])

/**
 * A reviewed package whose bytes have been acquired and verified: the only
 * shape allowed into the private snapshot store.
 */
export type StagedInstalledSkillCandidate = {
  candidate: Omit<AgentCodeInstalledSkillCandidate, 'files'> & {
    files: AgentCodeInstalledSkillFileRecord[]
  }
  snapshotDigest: string
  contents: Map<string, Buffer>
}

/** One file of a reviewed package, bound to the reviewed commit by its blob id. */
export type ReviewedSkillTreeEntry = {
  relativePath: string
  repositoryPath: string
  object: string
  executable: boolean
  size: number
}

/**
 * A package under review (#1161): tree metadata plus its verified SKILL.md.
 *
 * WHY discovery stops here instead of downloading the whole package: a
 * collection like anthropics/skills lists dozens of skills and people pick
 * one or two. Downloading every package before the review spent the whole
 * discovery budget on bytes nobody selected, which is why large collections
 * used to fail outright. The tree entries' blob ids are the reviewed identity;
 * `acquire` must reproduce exactly those bytes.
 */
export type ReviewedInstalledSkillCandidate = {
  candidate: AgentCodeInstalledSkillCandidate
  owner: string
  repository: string
  commit: string
  entries: ReviewedSkillTreeEntry[]
  skillMarkdown: Buffer
}

export type GitHubSkillDiscoveryPayload = {
  repositoryUrl: string
  requestedRef: string
  requestedRefType: GitRefType
  resolvedCommit: string
  candidates: ReviewedInstalledSkillCandidate[]
  notices: string[]
  missingSkills: string[]
}

export type GitHubSkillDiscoveryRequest = {
  source: SkillInstallGitHubSource
  /** `--full-depth`: keep searching below a root SKILL.md and always run the fallback. */
  fullDepth?: boolean
  /**
   * `--skill` names (matched case-insensitively against the frontmatter name
   * or the folder name, as `npx skills` does), `'*'` for every listed skill,
   * or null/absent to list everything for browsing.
   */
  skills?: string[] | '*' | null
}

type GitTreeEntry = {
  mode: string
  type: string
  object: string
  path: string
  size?: number
}

type ResolvedGitHubSource = {
  owner: string
  repository: string
  repositoryUrl: string
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

type DiscoveryAcquisitionBudget = {
  usedBytes: number
  maxBytes: number
}

export type GitHubSkillSourceOptions = {
  runGit?: GitRunner
  fetchBytes?: HttpRunner
  maxDiscoveryBytes?: number
}

/**
 * vercel-labs/skills `findSkillDirs` skips these in its fallback search.
 * Matching it keeps the same repository showing the same skills in both tools.
 */
const FALLBACK_SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__'])
/** `DEFAULT_SKILL_CONTAINER_DEPTH` in vercel-labs/skills. */
const CONTAINER_DEPTH = 3
/** `findSkillDirs` maxDepth in vercel-labs/skills. */
const FALLBACK_DEPTH = 5
const MARKETPLACE_MANIFEST_MAX_BYTES = 256 * 1024

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
  private readonly maxDiscoveryBytes: number

  constructor(options: GitHubSkillSourceOptions = {}) {
    this.runGit = options.runGit ?? runGitProcess
    this.fetchBytes = options.fetchBytes ?? fetchBoundedGitHubBytes
    this.maxDiscoveryBytes = options.maxDiscoveryBytes
      ?? AGENT_CODE_INSTALLED_SKILL_MAX_DISCOVERY_BYTES
  }

  async discover(request: GitHubSkillDiscoveryRequest): Promise<GitHubSkillDiscoveryPayload> {
    const environment = isolatedGitEnvironment()
    try {
      const resolved = await this.resolveSource(request.source, environment)
      const tree = await this.readGitHubTree(resolved)
      return await this.discoverCandidates({ resolved, tree, request })
    } catch (error) {
      throw classifyGitHubSkillSourceError(error)
    }
  }

  /**
   * Downloads the rest of a reviewed package and proves it is the reviewed one.
   *
   * WHY every file is checked against the reviewed blob id rather than just
   * the commit: raw URLs are addressed by commit + path, and the review was
   * shown for exactly these (path, object) pairs. A mismatch means GitHub (or
   * something between) served different bytes than the tree the user
   * approved, and nothing from this package may become durable.
   */
  async acquire(reviewed: ReviewedInstalledSkillCandidate): Promise<StagedInstalledSkillCandidate> {
    try {
      const contents = new Map<string, Buffer>()
      const files: AgentCodeInstalledSkillFileRecord[] = []
      let totalBytes = 0
      for (const entry of reviewed.entries) {
        const content = entry.relativePath === 'SKILL.md'
          ? reviewed.skillMarkdown
          : await this.fetchBytes(
              rawGitHubFileUrl(reviewed.owner, reviewed.repository, reviewed.commit, entry.repositoryPath),
              entry.size,
            )
        if (content.byteLength !== entry.size || gitBlobObjectId(content) !== entry.object) {
          throw new GitHubSkillSourceError(
            'network',
            `GitHub returned bytes that do not match the reviewed commit tree (${entry.relativePath}).`,
          )
        }
        totalBytes += content.byteLength
        contents.set(entry.relativePath, content)
        files.push({
          path: entry.relativePath,
          bytes: content.byteLength,
          sha256: sha256Buffer(content),
          executable: entry.executable,
        })
      }
      if (totalBytes > AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `The package exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES)} total limit.`,
        )
      }
      return {
        candidate: { ...reviewed.candidate, files, totalBytes },
        snapshotDigest: packageDigest(files),
        contents,
      }
    } catch (error) {
      throw classifyGitHubSkillSourceError(error)
    }
  }

  private async resolveSource(
    source: SkillInstallGitHubSource,
    environment: NodeJS.ProcessEnv,
  ): Promise<ResolvedGitHubSource> {
    const repositoryUrl = `https://github.com/${source.owner}/${source.repository}`
    const base = { owner: source.owner, repository: source.repository, repositoryUrl }
    const remote = `${repositoryUrl}.git`
    const refs = await this.gitText([
      '-c', 'credential.helper=',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      'ls-remote', '--symref', remote, 'HEAD', 'refs/heads/*', 'refs/tags/*',
    ], { environment })
    const advertised = parseAdvertisedRefs(refs)
    const requestedPath = source.subpath ?? ''
    if (requestedPath && !isSafeRepositoryPath(requestedPath)) {
      throw new GitHubSkillSourceError('validation', 'The directory path inside the repository is unsafe.')
    }

    if (source.ref !== undefined) {
      // `owner/repo#ref`: the ref is explicit, so no longest-prefix guessing.
      const identities = advertised.refs.get(source.ref) ?? []
      if (identities.length === 0) {
        throw new GitHubSkillSourceError('not-found', `The repository has no branch or tag named ${JSON.stringify(source.ref)}.`)
      }
      if (identities.length > 1) {
        throw new GitHubSkillSourceError(
          'validation',
          `GitHub advertises both a branch and tag named ${JSON.stringify(source.ref)}. Use an unambiguous source ref.`,
        )
      }
      const identity = identities[0]!
      if (identity.name.length > 512) {
        throw new GitHubSkillSourceError('validation', 'The GitHub branch or tag name is too long.')
      }
      return {
        ...base,
        requestedRef: identity.name,
        requestedRefType: identity.type,
        requestedCommit: identity.commit,
        requestedPath,
      }
    }

    const treeSegments = source.treeSegments ?? []
    if (treeSegments.length === 0) {
      if (!advertised.defaultRef) {
        throw new GitHubSkillSourceError('not-found', 'The repository has no discoverable default branch.')
      }
      if (advertised.defaultRef.name.length > 512) {
        throw new GitHubSkillSourceError('validation', 'The default GitHub branch name is too long.')
      }
      return {
        ...base,
        requestedRef: advertised.defaultRef.name,
        requestedRefType: advertised.defaultRef.type,
        requestedCommit: advertised.defaultRef.commit,
        requestedPath,
      }
    }

    let requestedRef: AdvertisedGitRef | null = null
    let refSegmentCount = 0
    for (let length = treeSegments.length; length >= 1; length -= 1) {
      const candidate = treeSegments.slice(0, length).join('/')
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
    const treePath = treeSegments.slice(refSegmentCount).join('/')
    if (treePath && !isSafeRepositoryPath(treePath)) {
      throw new GitHubSkillSourceError('validation', 'The GitHub directory path is unsafe.')
    }
    return {
      ...base,
      requestedRef: requestedRef.name,
      requestedRefType: requestedRef.type,
      requestedCommit: requestedRef.commit,
      requestedPath: treePath,
    }
  }

  /**
   * Chooses candidate skill folders exactly the way `npx skills` does
   * (vercel-labs/skills 1.7 `discoverSkills`), run over the verified commit
   * tree instead of a checkout.
   *
   * WHY mirror it instead of "every SKILL.md below the path" (the previous
   * rule): READMEs and skills.sh document commands against that tool, so the
   * same repository must show the same skills here. The old rule surfaced
   * `examples/**` and test fixtures as skills and rejected any repository
   * that nests skills (ambiguous-nesting error), which is common.
   */
  private selectCandidateRoots(
    tree: GitTreeEntry[],
    searchPath: string,
    fullDepth: boolean,
    pluginContainers: string[],
  ): string[] {
    const skillDirectories = new Set<string>()
    const children = new Map<string, Set<string>>()
    for (const entry of tree) {
      const segments = entry.path.split('/')
      if (segments[segments.length - 1] === 'SKILL.md') skillDirectories.add(segments.slice(0, -1).join('/'))
      for (let length = 1; length < segments.length; length += 1) {
        const parent = segments.slice(0, length - 1).join('/')
        const child = segments.slice(0, length).join('/')
        const set = children.get(parent) ?? new Set<string>()
        set.add(child)
        children.set(parent, set)
      }
    }
    const within = (path: string) => searchPath === '' || path === searchPath || path.startsWith(`${searchPath}/`)
    const join = (...parts: string[]) => parts.filter(Boolean).join('/')
    const ordered: string[] = []
    const seen = new Set<string>()
    const add = (directory: string) => {
      if (seen.has(directory)) return
      seen.add(directory)
      ordered.push(directory)
    }

    // 1. A SKILL.md at the search path is the answer, unless --full-depth.
    if (skillDirectories.has(searchPath)) {
      add(searchPath)
      if (!fullDepth) return ordered
    }

    // 2. Priority containers. The search path itself keeps depth 1 so a stray
    //    `examples/foo/SKILL.md` is not surfaced; the others go 3 deep and stop
    //    descending below a skill they found (walkSkillDirs).
    const walk = (directory: string, depth: number, maxDepth: number) => {
      const names = [...(children.get(directory) ?? [])].sort(compareAgentCodeInstalledSkillPaths)
      for (const child of names) {
        if (skillDirectories.has(child)) {
          add(child)
          continue
        }
        if (depth + 1 < maxDepth) walk(child, depth + 1, maxDepth)
      }
    }
    // WHY "every top-level `.<name>/skills`" instead of vercel's hard-coded
    // AGENT_PROJECT_SKILL_DIRS list: that list grows with every agent the
    // tool supports, and a superset finds the same folders (plus any new
    // agent's) without a release here. `.agents` and `.claude` stay first,
    // in vercel's order, so duplicate names resolve the same way.
    const agentContainers = [...(children.get(searchPath) ?? [])]
      .map(child => child.slice(searchPath ? searchPath.length + 1 : 0))
      .filter(name => /^\.[^/]+$/.test(name) && children.get(join(searchPath, name))?.has(join(searchPath, name, 'skills')))
      .map(name => `${name}/skills`)
      .sort((left, right) => agentContainerRank(left) - agentContainerRank(right)
        || compareAgentCodeInstalledSkillPaths(left, right))
    walk(searchPath, 0, 1)
    for (const container of [
      'skills',
      'skills/.curated',
      'skills/.experimental',
      'skills/.system',
      ...agentContainers,
    ]) {
      walk(join(searchPath, container), 0, CONTAINER_DEPTH)
    }
    // Plugin-manifest containers are walked one level deep, as vercel's
    // discoverSkills does for every non-root priority directory it gets from
    // getPluginSkillPaths (review round 1: listing only the exact declared
    // folder missed siblings and every plugin's conventional `skills/`).
    for (const container of pluginContainers) {
      if (within(container)) walk(container, 0, 1)
    }

    // 3. Fallback: nothing found, or --full-depth asked for everything.
    if (ordered.length === 0 || fullDepth) {
      const depthOf = (directory: string) => directory === searchPath
        ? 0
        : directory.slice(searchPath ? searchPath.length + 1 : 0).split('/').length
      for (const directory of [...skillDirectories].sort(compareAgentCodeInstalledSkillPaths)) {
        if (!within(directory) || depthOf(directory) > FALLBACK_DEPTH) continue
        const relative = directory.slice(searchPath ? searchPath.length + 1 : 0)
        if (relative.split('/').some(segment => FALLBACK_SKIP_DIRECTORIES.has(segment))) continue
        add(directory)
      }
    }
    return ordered
  }

  private async discoverCandidates(input: {
    resolved: ResolvedGitHubSource
    tree: GitTreeEntry[]
    request: GitHubSkillDiscoveryRequest
  }): Promise<GitHubSkillDiscoveryPayload> {
    const { resolved, tree, request } = input
    const notices: string[] = []
    // WHY SKILL.md reads share one budget with the marketplace manifest and
    // every rejected candidate: a hostile collection could otherwise make each
    // skipped folder download its full allowance. The budget now covers
    // SKILL.md files only (lazy acquisition), so it bounds work, not how many
    // skills a repository may hold.
    const acquisitionBudget: DiscoveryAcquisitionBudget = {
      usedBytes: 0,
      maxBytes: this.maxDiscoveryBytes,
    }
    const pluginContainers = await this.readPluginContainers(resolved, tree, acquisitionBudget, notices)
    const roots = this.selectCandidateRoots(
      tree,
      resolved.requestedPath,
      request.fullDepth === true,
      pluginContainers,
    )
    if (roots.length === 0) {
      throw new GitHubSkillSourceError(
        'not-found',
        resolved.requestedPath
          ? 'No SKILL.md package exists at or below that directory.'
          : 'No Agent Skills packages were found in that repository.',
      )
    }

    const requested = Array.isArray(request.skills)
      ? request.skills.map(name => name.toLowerCase())
      : null
    const folderName = (root: string) => root === '' ? resolved.repository : posix.basename(root)
    // Roots are read in DISCOVERY order even with a --skill list, and every
    // name read counts for duplicates, requested or not (review round 1): an
    // earlier version read folder-name matches first, so `--skill pdf` could
    // pick a later `pdf` than the one `npx skills` (discover, then filter)
    // installs. Reading stops once every requested name is matched — a later
    // duplicate could never win anyway.
    const byName = new Map<string, ReviewedInstalledSkillCandidate>()
    const firstSeen = new Map<string, string>()
    const matched = new Set<string>()
    for (const root of roots) {
      if (requested && requested.every(name => matched.has(name))) break
      let reviewed: ReviewedInstalledSkillCandidate
      try {
        reviewed = await this.readCandidate({ root, resolved, tree, acquisitionBudget })
      } catch (error) {
        const classified = classifyGitHubSkillSourceError(error)
        if (roots.length === 1 || error instanceof GitHubSkillDiscoveryLimitError) throw classified
        notices.push(`${displayRoot(root)} was skipped: ${classified.message}`)
        continue
      }
      const name = reviewed.candidate.name
      const keys = [name.toLowerCase(), folderName(root).toLowerCase()]
      const earlier = firstSeen.get(name)
      if (earlier !== undefined) {
        // First one found wins, as in `npx skills` (seenNames). The old
        // behaviour rejected the whole repository.
        if (!requested || keys.some(key => requested.includes(key))) {
          notices.push(
            `${displayRoot(root)} was skipped: another skill named ${name} was found first at ${displayRoot(earlier)}.`,
          )
        }
        continue
      }
      firstSeen.set(name, root)
      if (requested && !keys.some(key => requested.includes(key))) continue
      // `metadata.internal` skills are hidden from browsing and `--skill '*'`
      // and appear only when named, matching vercel's includeInternal rule.
      if (reviewed.candidate.internal && !requested) continue
      for (const key of keys) if (requested?.includes(key)) matched.add(key)
      byName.set(name, reviewed)
    }
    const candidates = [...byName.values()]
    const missingSkills = requested
      ? (request.skills as string[]).filter(name => !matched.has(name.toLowerCase()))
      : []
    if (candidates.length === 0) {
      throw new GitHubSkillSourceError(
        requested ? 'not-found' : 'validation',
        requested
          ? `No skill named ${missingSkills.join(', ')} was found in ${resolved.owner}/${resolved.repository}.`
          : notices[0] ?? 'No valid Agent Skills packages were found.',
      )
    }
    return {
      repositoryUrl: resolved.repositoryUrl,
      requestedRef: resolved.requestedRef,
      requestedRefType: resolved.requestedRefType,
      resolvedCommit: resolved.requestedCommit,
      candidates,
      notices,
      missingSkills,
    }
  }

  /**
   * Containers declared by plugin manifests at the search path, ported from
   * vercel-labs/skills `getPluginSkillPaths` (review round 1 found the first
   * version missed most of it):
   * - `.claude-plugin/marketplace.json`: each plugin's base is
   *   `metadata.pluginRoot` + its string `source` (remote object sources are
   *   skipped); every plugin contributes `<base>/skills` plus the PARENT of
   *   each listed skill path.
   * - `.claude-plugin/plugin.json`: the same for a single plugin at the root.
   * Paths must start with `./` and stay inside the repository, per the
   * manifest spec. Best effort: a malformed manifest is a notice, never a
   * failed discovery.
   */
  private async readPluginContainers(
    resolved: ResolvedGitHubSource,
    tree: GitTreeEntry[],
    budget: DiscoveryAcquisitionBudget,
    notices: string[],
  ): Promise<string[]> {
    const containers: string[] = []
    const base = resolved.requestedPath
    const addContainer = (...parts: string[]) => {
      const normalized = posix.normalize(posix.join(base || '.', ...parts))
      const path = normalized === '.' ? '' : normalized.replace(/\/+$/, '')
      if (path === '..' || path.startsWith('../') || (path && !isSafeRepositoryPath(path))) return
      containers.push(path)
    }
    const relative = (value: unknown): string | null =>
      typeof value === 'string' && value.startsWith('./') ? value : null
    const addPlugin = (pluginBase: string, skills: unknown) => {
      addContainer(pluginBase, 'skills')
      if (!Array.isArray(skills)) return
      for (const skill of skills) {
        const path = relative(skill)
        if (path) addContainer(posix.dirname(posix.join(pluginBase, path)))
      }
    }

    const marketplace = await this.readManifest(resolved, tree, budget, notices, '.claude-plugin/marketplace.json')
    if (isRecord(marketplace)) {
      const metadata = isRecord(marketplace.metadata) ? marketplace.metadata : {}
      const pluginRoot = relative(metadata.pluginRoot) ?? '.'
      for (const plugin of Array.isArray(marketplace.plugins) ? marketplace.plugins : []) {
        if (!isRecord(plugin)) continue
        if (plugin.source !== undefined && typeof plugin.source !== 'string') continue
        const source = plugin.source === undefined ? '.' : relative(plugin.source)
        if (!source) continue
        addPlugin(posix.join(pluginRoot, source), plugin.skills)
      }
    }
    const single = await this.readManifest(resolved, tree, budget, notices, '.claude-plugin/plugin.json')
    if (isRecord(single)) addPlugin('.', single.skills)
    return [...new Set(containers)]
  }

  private async readManifest(
    resolved: ResolvedGitHubSource,
    tree: GitTreeEntry[],
    budget: DiscoveryAcquisitionBudget,
    notices: string[],
    name: string,
  ): Promise<unknown> {
    const manifestPath = [resolved.requestedPath, name].filter(Boolean).join('/')
    const entry = tree.find(value => value.path === manifestPath && value.type === 'blob')
    if (!entry || entry.size === undefined || entry.size > MARKETPLACE_MANIFEST_MAX_BYTES) return null
    if (entry.size > budget.maxBytes - budget.usedBytes) return null
    budget.usedBytes += entry.size
    try {
      const bytes = await this.fetchBytes(
        rawGitHubFileUrl(resolved.owner, resolved.repository, resolved.requestedCommit, entry.path),
        entry.size,
      )
      if (gitBlobObjectId(bytes) !== entry.object) return null
      return JSON.parse(decodeUtf8(bytes, name))
    } catch {
      notices.push(`${name} could not be read; its skill list was ignored.`)
      return null
    }
  }

  private async readCandidate(input: {
    root: string
    resolved: ResolvedGitHubSource
    tree: GitTreeEntry[]
    acquisitionBudget: DiscoveryAcquisitionBudget
  }): Promise<ReviewedInstalledSkillCandidate> {
    const { root, resolved, tree, acquisitionBudget } = input
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
    // Every structural rule is decided from the tree BEFORE any download, so
    // a package that can never be installed costs nothing but its SKILL.md.
    let totalBytes = 0
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
      if (entry.size === undefined || entry.size > AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES) {
        throw new GitHubSkillSourceError(
          'validation',
          `${entry.relativePath} exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)} per-file limit.`,
        )
      }
      totalBytes += entry.size
    }
    if (totalBytes > AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES) {
      throw new GitHubSkillSourceError(
        'validation',
        `The package exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES)} total limit.`,
      )
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

    const skillEntry = entries.find(entry => entry.relativePath === 'SKILL.md')
    if (!skillEntry || skillEntry.size === undefined) {
      throw new GitHubSkillSourceError('validation', 'The package has no root SKILL.md.')
    }
    if (skillEntry.size > AGENT_CODE_INSTALLED_SKILL_MAX_SKILL_MD_BYTES) {
      throw new GitHubSkillSourceError(
        'validation',
        `SKILL.md exceeds the ${formatBytes(AGENT_CODE_INSTALLED_SKILL_MAX_SKILL_MD_BYTES)} limit.`,
      )
    }
    if (skillEntry.size > acquisitionBudget.maxBytes - acquisitionBudget.usedBytes) {
      throw new GitHubSkillDiscoveryLimitError(acquisitionBudget.maxBytes)
    }
    // WHY capacity is reserved before transport and never refunded: a
    // response may deliver its body and then fail on the stream trailer or
    // connection. Charging only resolved fetches would let the collection
    // loop skip that candidate and spend the same allowance again.
    acquisitionBudget.usedBytes += skillEntry.size
    let skillBytes: Buffer
    try {
      skillBytes = await this.fetchBytes(
        rawGitHubFileUrl(resolved.owner, resolved.repository, resolved.requestedCommit, skillEntry.path),
        skillEntry.size,
      )
    } catch (error) {
      if (error instanceof GitHubSkillSourceError
        && error.code === 'validation'
        && error.message.includes('acquisition limit')) {
        throw new GitHubSkillDiscoveryLimitError(acquisitionBudget.maxBytes)
      }
      throw error
    }
    if (skillBytes.byteLength > skillEntry.size) throw new GitHubSkillDiscoveryLimitError(acquisitionBudget.maxBytes)
    if (gitBlobObjectId(skillBytes) !== skillEntry.object) {
      throw new GitHubSkillSourceError(
        'network',
        'GitHub returned bytes that do not match the reviewed commit tree (SKILL.md).',
      )
    }
    const frontmatter = parseSkillFrontmatter(decodeUtf8(skillBytes, 'SKILL.md'))
    // WHY the folder no longer has to be named after the skill (#1161): Agent
    // Code materializes every package to `<provider root>/<frontmatter name>`,
    // exactly as `npx skills` installs it, so the SOURCE folder name never
    // reaches a provider. The old rule only rejected real repositories — a
    // root SKILL.md in a repo named `foo-skill` whose skill is `foo`.

    const warnings: string[] = []
    const executableFiles = entries.filter(entry => entry.mode === '100755').map(entry => entry.relativePath)
    if (executableFiles.length > 0) {
      warnings.push(summarizeValues(
        `Contains ${executableFiles.length} executable file${executableFiles.length === 1 ? '' : 's'}`,
        executableFiles,
      ))
    }
    const providerFiles = entries.map(entry => entry.relativePath).filter(isProviderSpecificPath)
    if (providerFiles.length > 0) {
      warnings.push(summarizeValues('Contains provider-specific metadata', providerFiles))
    }
    const extraFields = frontmatter.fields.filter(field => !PORTABLE_FRONTMATTER_FIELDS.has(field))
    if (extraFields.length > 0) {
      warnings.push(summarizeValues('Uses unrecognized frontmatter fields', extraFields))
    }

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
      resolvedCommit: resolved.requestedCommit,
    }
    const reviewedEntries: ReviewedSkillTreeEntry[] = entries.map(entry => ({
      relativePath: entry.relativePath,
      repositoryPath: entry.path,
      object: entry.object,
      executable: entry.mode === '100755',
      size: entry.size!,
    }))
    // The id binds the review to the exact (path, mode, blob) set at this
    // commit, which is known before download and is exactly what `acquire`
    // must reproduce.
    const identity = reviewedEntries
      .map(entry => `${entry.relativePath}\0${entry.executable ? '1' : '0'}\0${entry.object}`)
      .join('\0')
    const candidate: AgentCodeInstalledSkillCandidate = {
      candidateId: sha256Text(
        `${resolved.owner}/${resolved.repository}\0${resolved.requestedCommit}\0${root}\0${identity}`,
      ).slice(0, 32),
      name: frontmatter.name,
      description: frontmatter.description,
      source,
      files: reviewedEntries.map(entry => ({
        path: entry.relativePath,
        bytes: entry.size,
        executable: entry.executable,
      })),
      totalBytes,
      warnings,
      ...(frontmatter.internal ? { internal: true } : {}),
    }
    return {
      candidate,
      owner: resolved.owner,
      repository: resolved.repository,
      commit: resolved.requestedCommit,
      entries: reviewedEntries,
      skillMarkdown: skillBytes,
    }
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

class GitHubSkillDiscoveryLimitError extends GitHubSkillSourceError {
  constructor(maxBytes: number) {
    super(
      'validation',
      `The discovery exceeds ${formatBytes(maxBytes)} of package content. Use a narrower GitHub directory URL.`,
    )
    this.name = 'GitHubSkillDiscoveryLimitError'
  }
}

export function parseSkillFrontmatter(text: string): {
  name: string
  description: string
  fields: string[]
  internal: boolean
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
  // `metadata.internal: true` hides a skill from `npx skills` browsing; the
  // same flag hides it here (see discoverCandidates).
  const metadata = frontmatter.get('metadata')
  const internal = metadata instanceof Map && metadata.get('internal') === true
  return { name, description, fields: fields.sort(), internal }
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
      // GitHub's tree contract includes byte size for every blob. Requiring it
      // lets discovery reserve aggregate capacity before issuing the raw-file
      // request instead of discovering an overrun after transport.
      || (value.type === 'blob'
        && (!Number.isSafeInteger(value.size) || Number(value.size) < 0))) {
      throw new GitHubSkillSourceError('validation', 'The repository contains an unsupported Git tree entry.')
    }
    entries.push({
      mode: value.mode,
      type: value.type,
      object: value.sha,
      path: value.path,
      size: value.type === 'blob' ? Number(value.size) : undefined,
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

/** `.agents/skills` then `.claude/skills` first, as in vercel's AGENT_PROJECT_SKILL_DIRS. */
function agentContainerRank(container: string): number {
  if (container === '.agents/skills') return 0
  if (container === '.claude/skills') return 1
  return 2
}

function isWithinRepositoryPath(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`)
}

function displayRoot(root: string): string {
  return root || 'repository root'
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

function rawGitHubFileUrl(owner: string, repository: string, commit: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repository}`
    + `/${commit}/${encodeGitHubPath(path)}`
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
