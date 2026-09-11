import { opendir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { asRecord } from '@shared/lib/asRecord.js'
import type { AgentSkillDiscovery, AgentSkillRoot, AgentSkillsSnapshot, ManagedAgentSkillLocations } from '@shared/types/agentSkills.js'
import { missingSkillPath, readSkillFile } from '@providers/shared/runtime/skillDiscovery.js'

const MAX_ENTRIES = 10_000
const MAX_SKILLS = 1_000
const MAX_DEPTH = 12

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
  const fallbackName = basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path, '.md')
  const name = typeof header.name === 'string' && header.name.trim() ? header.name.trim() : optional ? fallbackName : null
  const description = typeof header.description === 'string' ? header.description.trim() : ''
  if (!name || name.length > 256 || (!description && !optional)) throw new Error('Invalid skill identity')
  return {
    name,
    description: description.length > 4096 ? `${description.slice(0, 4096)}…` : description,
  }
}

export async function collectInstalledAgentSkills(
  discovery: AgentSkillDiscovery,
  managed: ManagedAgentSkillLocations,
): Promise<AgentSkillsSnapshot> {
  const skills: AgentSkillsSnapshot['skills'] = []
  const notices = [...discovery.notices, ...managed.notices]
  const seenFiles = new Set<string>()
  const seenDirectories = new Set<string>()
  const ownedFiles = new Set(await Promise.all(managed.paths.map(path => realpath(path).catch(() => path))))
  let entries = 0
  let limited = false

  async function addFile(path: string, root: AgentSkillRoot): Promise<boolean> {
    try {
      const text = await readSkillFile(path, undefined, true)
      if (text === null) return false
      const physical = await realpath(path)
      if (seenFiles.has(physical)) return true
      const value = metadata(text, path, root.legacyCommands === true || root.optionalFrontmatter === true)
      seenFiles.add(physical)
      skills.push({
        ...value, path,
        source: ownedFiles.has(physical) ? 'agent-code' : root.source,
        sourceLabel: ownedFiles.has(physical) ? undefined : root.sourceLabel,
      })
      return true
    } catch {
      notices.push(`Could not read skill metadata: ${path}`)
      return true
    }
  }

  async function walk(path: string, root: AgentSkillRoot, depth: number): Promise<void> {
    if (entries >= MAX_ENTRIES || skills.length >= MAX_SKILLS || depth > MAX_DEPTH) {
      limited = true
      return
    }
    try {
      const physical = await realpath(path)
      if (seenDirectories.has(physical)) return
      seenDirectories.add(physical)
      // Stop at the skill boundary: its references/scripts are supporting
      // assets, not further installations. Explicit .system roots are handled
      // separately because ordinary hidden folders are intentionally skipped.
      if (await addFile(join(path, 'SKILL.md'), root)) return
      const directory = await opendir(path)
      for await (const entry of directory) {
        if (++entries > MAX_ENTRIES || skills.length >= MAX_SKILLS) { limited = true; break }
        if (entry.name.startsWith('.')) continue
        const child = join(path, entry.name)
        if (entry.isDirectory() || entry.isSymbolicLink()) await walk(child, root, depth + 1)
        else if (root.legacyCommands && entry.isFile() && entry.name.endsWith('.md')) await addFile(child, root)
      }
    } catch (error) {
      if (!missingSkillPath(error)) notices.push(`Could not scan skill directory: ${path}`)
    }
  }

  for (const root of discovery.roots) {
    if (entries >= MAX_ENTRIES || skills.length >= MAX_SKILLS) { limited = true; break }
    if (root.path.endsWith('/SKILL.md') || root.path.endsWith('\\SKILL.md')) await addFile(root.path, root)
    else await walk(root.path, root, 0)
  }
  if (limited) notices.push('Skill discovery reached its scan limit; the list may be incomplete.')
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return { skills, notices: [...new Set(notices)] }
}
