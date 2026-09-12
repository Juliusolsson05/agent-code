import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { asRecord } from '@shared/lib/asRecord.js'
import type {
  AgentSkillDiscovery,
  AgentSkillRoot,
  AgentSkillsSnapshot,
  InstalledAgentSkill,
  ManagedAgentSkillLocations,
} from '@shared/types/agentSkills.js'
import { missingSkillPath, readSkillFile } from '@providers/shared/runtime/skillDiscovery.js'

export type SkillInventoryLimits = {
  /** Root probes, directory listings, listed entries and metadata reads, across ALL roots. */
  entries: number
  skills: number
  /** Safety ceiling for layouts whose provider walk is unbounded. */
  depth: number
  /** Individually named unreadable files; the rest are summarized in one line. */
  failureNotices: number
}

// WHY one shared budget that charges every probe, listing, entry AND metadata
// read: the first version only counted directory enumeration. Review showed
// that roots whose SKILL.md was malformed returned before enumeration (10,002
// YAML parses and notices from one adversarial plugin), and in round two that
// missing command roots were still `stat`ed for free (10,001 calls under a
// budget of 4). Every unit of filesystem work now draws from the same pool,
// and failure notices are capped separately so a broken tree cannot flood the
// renderer either.
export const SKILL_INVENTORY_LIMITS: SkillInventoryLimits = {
  entries: 10_000,
  skills: 1_000,
  depth: 16,
  failureNotices: 10,
}

const SKILL_FILE = 'SKILL.md'
/**
 * Codex plugin manifest folders (exec-server-protocol
 * DISCOVERABLE_PLUGIN_MANIFEST_PATHS), in Codex's lookup order. Only roots with
 * `resolvePluginNamespaces` consult them.
 */
const PLUGIN_MANIFEST_DIRECTORIES = ['.codex-plugin', '.claude-plugin', '.cursor-plugin']

/** Component-wise containment like Codex `PathUri::starts_with`: `/a/bc` is not inside `/a/b`. */
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function metadata(text: string, path: string, optional: boolean): { name: string; description: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match && (!optional || normalized.startsWith('---\n'))) throw new Error('Missing frontmatter')
  const parsed = match ? parseDocument(match[1]!, { uniqueKeys: true }) : null
  if (parsed?.errors.length) throw new Error('Invalid frontmatter')
  // Disallow aliases rather than letting a tiny header inflate arbitrarily.
  // The skill body is never parsed/rendered, and dynamic shell substitutions
  // in Claude skills are just inert text to this inspector.
  const header = asRecord(parsed?.toJS({ maxAliasCount: 0 })) ?? {}
  // Claude names a skill-format command after its folder and a plain command
  // after its file (`getCommandName` in loadSkillsDir.ts), case-insensitively.
  const fallbackName = /^skill\.md$/i.test(basename(path))
    ? basename(dirname(path))
    : basename(path).replace(/\.md$/i, '')
  const name = typeof header.name === 'string' && header.name.trim() ? header.name.trim() : optional ? fallbackName : null
  const description = typeof header.description === 'string' ? header.description.trim() : ''
  if (!name || name.length > 256 || (!description && !optional)) throw new Error('Invalid skill identity')
  return {
    name,
    description: description.length > 4096 ? `${description.slice(0, 4096)}…` : description,
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

type ListedEntry = { name: string; path: string; kind: 'file' | 'directory' }
type FoundSkill = InstalledAgentSkill & { physical: string }

/**
 * Read-only metadata inventory over provider-declared roots.
 *
 * The collector owns HOW files are read (bounded, non-blocking, deduplicated by
 * physical path, bodies discarded); provider adapters own WHERE and in which
 * layout. Roots are processed in order and the first root to reach a physical
 * FILE decides its label, so adapters order roots the way their provider
 * deduplicates them.
 *
 * `limitOverrides` exists for the budget tests only: exercising the production
 * 10,000-entry ceiling would need tens of thousands of fixture files.
 */
export async function collectInstalledAgentSkills(
  discovery: AgentSkillDiscovery,
  managed: ManagedAgentSkillLocations,
  limitOverrides: Partial<SkillInventoryLimits> = {},
): Promise<AgentSkillsSnapshot> {
  const limits = { ...SKILL_INVENTORY_LIMITS, ...limitOverrides }
  const found: FoundSkill[] = []
  const failures: string[] = []
  const seenFiles = new Set<string>()
  const ownedFiles = new Set(await Promise.all(managed.paths.map(canonical)))
  let remaining = limits.entries
  let limited = false

  const exhausted = () => remaining <= 0 || found.length >= limits.skills
  const spend = (): boolean => {
    if (exhausted()) {
      limited = true
      return false
    }
    remaining -= 1
    return true
  }
  // `stat` follows links, so a linked SKILL.md counts. Anything that is not a
  // directory proceeds to `add`, where a FIFO or device is rejected with a
  // notice instead of disappearing silently.
  const present = async (path: string): Promise<boolean> => {
    if (!spend()) return false
    return (await stat(path).catch(() => null))?.isDirectory() === false
  }

  async function add(path: string, root: AgentSkillRoot): Promise<void> {
    if (!spend()) return
    try {
      const text = await readSkillFile(path, undefined, true)
      if (text === null) return
      const physical = await realpath(path)
      // Round-three review: Codex resolves each Agent Plugin skill and drops one
      // whose real path leaves the canonical plugin root (loader/host.rs,
      // "resolves outside plugin root"). Without this a `skills/x` link to an
      // unrelated folder was listed as the plugin's own skill under its namespace.
      if (root.containWithin && !within(physical, await canonical(root.containWithin))) {
        failures.push(`Skipped a plugin skill that resolves outside its plugin folder: ${path}`)
        return
      }
      if (seenFiles.has(physical)) return
      const value = metadata(text, path, root.optionalFrontmatter === true)
      seenFiles.add(physical)
      const owned = ownedFiles.has(physical)
      found.push({
        ...value,
        name: root.namespace ? `${root.namespace}:${value.name}` : value.name,
        path,
        physical,
        source: owned ? 'agent-code' : root.source,
        ...(!owned && root.sourceLabel ? { sourceLabel: root.sourceLabel } : {}),
      })
    } catch {
      failures.push(`Could not read skill metadata: ${path}`)
    }
  }

  // WHY `visited` is per root walk rather than global: it exists to terminate
  // symlink cycles inside one walk. Sharing it across roots meant a folder
  // named by two roots with different layouts was read only under the first
  // one — a Claude plugin pointing both `skills` and `commands` at one folder
  // lost every command (round-two review). Duplicates across roots are still
  // collapsed by physical FILE identity, which is what decides labels.
  async function list(directory: string, root: AgentSkillRoot, visited: Set<string>): Promise<ListedEntry[] | null> {
    if (!spend()) return null
    try {
      const physical = await realpath(directory)
      if (visited.has(physical)) return null
      visited.add(physical)
      const entries: ListedEntry[] = []
      for await (const entry of await opendir(directory)) {
        if (!spend()) break
        const path = join(directory, entry.name)
        if (entry.isDirectory()) entries.push({ name: entry.name, path, kind: 'directory' })
        else if (entry.isFile()) entries.push({ name: entry.name, path, kind: 'file' })
        else if (entry.isSymbolicLink()) {
          const target = await stat(path).catch(() => null)
          if (target?.isDirectory()) {
            if (root.followDirectorySymlinks !== false) entries.push({ name: entry.name, path, kind: 'directory' })
          } else if (target) {
            entries.push({ name: entry.name, path, kind: 'file' })
          }
        }
      }
      return entries
    } catch (error) {
      if (!missingSkillPath(error)) failures.push(`Could not scan skill directory: ${directory}`)
      return null
    }
  }

  async function children(root: AgentSkillRoot): Promise<void> {
    if (root.rootMayBeSkill && await present(join(root.path, SKILL_FILE))) {
      // Claude's plugin loader treats a skill path that directly holds SKILL.md
      // as that one skill and does not look at its subfolders.
      await add(join(root.path, SKILL_FILE), root)
      return
    }
    for (const entry of await list(root.path, root, new Set()) ?? []) {
      if (exhausted()) break
      // Loose files (including a stray `skills/SKILL.md`) are not skills here.
      if (entry.kind !== 'directory' || (!root.includeHidden && entry.name.startsWith('.'))) continue
      if (await present(join(entry.path, SKILL_FILE))) await add(join(entry.path, SKILL_FILE), root)
    }
  }

  async function recursive(root: AgentSkillRoot, pluginFolders: Set<string>): Promise<void> {
    const providerBounded = root.maxDepth !== undefined
    const maxDepth = Math.min(root.maxDepth ?? limits.depth, limits.depth)
    const visited = new Set<string>()
    // `depth` is the folder's distance below the root; its SKILL.md sits at
    // depth + 1 path segments, matching Codex's walk `max_depth` accounting.
    const visit = async (directory: string, depth: number): Promise<void> => {
      const entries = await list(directory, root, visited) ?? []
      // Codex records a plugin root for every walked `.codex-plugin`-style
      // FOLDER entry (loader/discovery.rs) before pruning hidden folders, which
      // is why this inspects the listing rather than the folders it descends into.
      if (root.resolvePluginNamespaces
        && entries.some(entry => entry.kind === 'directory' && PLUGIN_MANIFEST_DIRECTORIES.includes(entry.name))) {
        pluginFolders.add(directory)
      }
      for (const entry of entries) {
        if (exhausted()) return
        if (entry.kind === 'file') {
          if (entry.name === SKILL_FILE) await add(entry.path, root)
          continue
        }
        if (!root.includeHidden && entry.name.startsWith('.')) continue
        if (depth + 2 > maxDepth) {
          // Codex's own depth limit is its real behavior, not an incomplete scan.
          if (!providerBounded) limited = true
          continue
        }
        await visit(entry.path, depth + 1)
      }
    }
    await visit(root.path, 0)
  }

  async function commands(root: AgentSkillRoot): Promise<void> {
    if (!spend()) return
    const info = await stat(root.path).catch(() => null)
    if (!info) return
    if (!info.isDirectory()) {
      // Plugin manifests may name individual command files.
      if (/\.md$/i.test(root.path)) await add(root.path, root)
      return
    }
    const visited = new Set<string>()
    const visit = async (directory: string, depth: number): Promise<void> => {
      const entries = await list(directory, root, visited)
      if (!entries) return
      const markdown = entries.filter(entry => entry.kind === 'file' && /\.md$/i.test(entry.name))
      // transformSkillFiles: a folder holding SKILL.md contributes only that file;
      // its sibling Markdown is supporting material, not more commands.
      const skill = markdown.find(entry => /^skill\.md$/i.test(entry.name))
      for (const file of skill ? [skill] : markdown) {
        if (exhausted()) return
        await add(file.path, root)
      }
      if (skill && root.stopAtSkillDirectory) return
      for (const entry of entries) {
        if (exhausted()) return
        if (entry.kind !== 'directory' || (!root.includeHidden && entry.name.startsWith('.'))) continue
        if (depth + 1 >= limits.depth) {
          limited = true
          continue
        }
        await visit(entry.path, depth + 1)
      }
    }
    await visit(root.path, 0)
  }

  // Manifest lookups are cached per directory for the whole inventory, as Codex
  // caches them per root scan, so sibling skills and overlapping roots share
  // ancestor probes. `null` means "no valid manifest here".
  const manifestNamespaces = new Map<string, string | null>()

  /** utils/plugins/src/plugin_namespace.rs plugin_namespace_for_root_uri. */
  async function manifestNamespace(directory: string): Promise<string | null> {
    const cached = manifestNamespaces.get(directory)
    if (cached !== undefined) return cached
    let manifest: string | null = null
    for (const folder of PLUGIN_MANIFEST_DIRECTORIES) {
      // Budget exhaustion is reported as an incomplete scan and never cached as
      // "no plugin here".
      if (!spend()) return null
      const candidate = join(directory, folder, 'plugin.json')
      if ((await stat(candidate).catch(() => null))?.isFile()) {
        manifest = candidate
        break
      }
    }
    let namespace: string | null = null
    if (manifest !== null) {
      if (!spend()) return null
      try {
        // Codex deserializes `{ name: String }` with `name` defaulting to "" and
        // stops at the FIRST manifest file: unparseable JSON or a non-string
        // name means no namespace at all, a blank name falls back to the folder
        // name, and a real name is kept exactly as written (untrimmed).
        const value = asRecord(JSON.parse(await readSkillFile(manifest, 1024 * 1024) ?? ''))
        const name = value?.name === undefined ? '' : value.name
        if (value && typeof name === 'string') namespace = name.trim() ? name : basename(directory)
      } catch {
        namespace = null
      }
    }
    manifestNamespaces.set(directory, namespace)
    return namespace
  }

  /** namespace.rs discover: the nearest valid manifest from a folder up to the filesystem root. */
  async function nearestManifestNamespace(directory: string): Promise<string | null> {
    for (let current = directory; !exhausted(); current = dirname(current)) {
      const namespace = await manifestNamespace(current)
      if (namespace !== null || dirname(current) === current) return namespace
    }
    return null
  }

  type NestedNamespace = { path: string; namespace: string | null }

  /**
   * Codex host roots (`$CODEX_HOME/skills`, `~/.agents/skills`, repo roots…)
   * have no owning plugin, so Codex derives each skill's namespace
   * (ext/skills/src/loader/namespace.rs SkillNamespaceResolver::discover and
   * for_skill, fed by loader/host.rs). Mirrored step by step:
   *
   * 1. Codex scans the CANONICAL root, so a skill's discovered path is the
   *    canonical root plus the walked components. A skill whose real path
   *    differs was reached through a link, and its real folder becomes a
   *    "namespace root".
   * 2. Folders holding a `.codex-plugin`-style folder become "plugin roots" —
   *    only above a loaded skill, and never the scan root or a namespace root.
   * 3. Namespace roots and the scan root resolve through their ancestors (a
   *    namespace root with no manifest above it is explicitly plain); plugin
   *    roots resolve only from their own manifest, and invalid ones are dropped.
   * 4. Per skill, the deepest nested root containing its real path wins, except
   *    that a link target at or above the scan root cannot rename a skill that
   *    still lives inside the root; otherwise the scan root's inherited name.
   *
   * WHY the panel needs this: `[[skills.config]]` name rules match the
   * qualified name. The round-three review showed a personal link into an
   * installed plugin listed as bare `review` while Codex loads, and a rule
   * disables, `sample:review`.
   */
  async function resolvePluginNamespaces(root: AgentSkillRoot, skills: FoundSkill[], pluginFolders: Set<string>): Promise<void> {
    if (skills.length === 0) return
    const scanRoot = await canonical(root.path)
    const discovered = (path: string) => join(scanRoot, relative(root.path, path))
    const namespaceRoots = new Set<string>()
    for (const skill of skills) {
      if (skill.physical !== discovered(skill.path)) namespaceRoots.add(dirname(skill.physical))
    }
    namespaceRoots.delete(scanRoot)
    // Every ancestor of an earlier skill is already present, so a walk can stop
    // at the first folder it has seen.
    const skillAncestors = new Set<string>()
    for (const skill of skills) {
      for (let current = dirname(skill.physical); !skillAncestors.has(current); current = dirname(current)) {
        skillAncestors.add(current)
        if (dirname(current) === current) break
      }
    }
    const nested: NestedNamespace[] = []
    for (const path of namespaceRoots) nested.push({ path, namespace: await nearestManifestNamespace(path) })
    for (const folder of pluginFolders) {
      const path = discovered(folder)
      if (!skillAncestors.has(path) || path === scanRoot || namespaceRoots.has(path)) continue
      const namespace = await manifestNamespace(path)
      if (namespace !== null) nested.push({ path, namespace })
    }
    const inherited = await nearestManifestNamespace(scanRoot)
    const depth = (path: string) => path.split(sep).length
    for (const skill of skills) {
      const insideRoot = within(skill.physical, scanRoot)
      const nearest = nested
        .filter(candidate => within(skill.physical, candidate.path) && (!insideRoot || !within(scanRoot, candidate.path)))
        .reduce<NestedNamespace | null>((best, candidate) => (!best || depth(candidate.path) > depth(best.path) ? candidate : best), null)
      const namespace = nearest ? nearest.namespace : inherited
      if (namespace !== null) skill.name = `${namespace}:${skill.name}`
    }
  }

  for (const root of discovery.roots) {
    if (exhausted()) {
      limited = true
      break
    }
    if (root.layout === 'children') await children(root)
    else if (root.layout === 'commands') await commands(root)
    else {
      const firstSkill = found.length
      const pluginFolders = new Set<string>()
      await recursive(root, pluginFolders)
      // Names must be final before the enablement rules below match them.
      if (root.resolvePluginNamespaces) await resolvePluginNamespaces(root, found.slice(firstSkill), pluginFolders)
    }
  }

  if (discovery.enablementRules?.length) {
    // Codex keys path rules by the canonical SKILL.md path; canonicalize both
    // sides so /var vs /private/var or a linked CODEX_HOME cannot defeat a rule.
    // Name rules compare against the (namespace-qualified) listed name.
    const disabled = new Set<string>()
    for (const rule of discovery.enablementRules) {
      const matches = 'path' in rule
        ? [await canonical(rule.path)]
        : found.filter(skill => skill.name === rule.name).map(skill => skill.physical)
      for (const physical of matches) {
        if (rule.enabled) disabled.delete(physical)
        else disabled.add(physical)
      }
    }
    for (const skill of found) {
      if (disabled.has(skill.physical)) skill.disabled = true
    }
  }

  const notices = [...discovery.notices, ...managed.notices, ...failures.slice(0, limits.failureNotices)]
  if (failures.length > limits.failureNotices) {
    // "list", not "read metadata": failures also cover unscannable folders and
    // plugin skills rejected for resolving outside their plugin.
    notices.push(`Could not list ${failures.length - limits.failureNotices} more skill files.`)
  }
  if (limited) notices.push('Skill discovery reached its scan limit; the list may be incomplete.')
  const skills = found
    .map(({ physical: _physical, ...skill }) => skill)
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return { skills, notices: [...new Set(notices)] }
}
