import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
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

  async function recursive(root: AgentSkillRoot): Promise<void> {
    const providerBounded = root.maxDepth !== undefined
    const maxDepth = Math.min(root.maxDepth ?? limits.depth, limits.depth)
    const visited = new Set<string>()
    // `depth` is the folder's distance below the root; its SKILL.md sits at
    // depth + 1 path segments, matching Codex's walk `max_depth` accounting.
    const visit = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await list(directory, root, visited) ?? []) {
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

  for (const root of discovery.roots) {
    if (exhausted()) {
      limited = true
      break
    }
    if (root.layout === 'children') await children(root)
    else if (root.layout === 'recursive') await recursive(root)
    else await commands(root)
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
    notices.push(`Could not read metadata for ${failures.length - limits.failureNotices} more skill files.`)
  }
  if (limited) notices.push('Skill discovery reached its scan limit; the list may be incomplete.')
  const skills = found
    .map(({ physical: _physical, ...skill }) => skill)
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return { skills, notices: [...new Set(notices)] }
}
