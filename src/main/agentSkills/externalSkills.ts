import { lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { AgentCodeManagedSkillsService } from '@main/agentCodeConventions/AgentCodeManagedSkillsService.js'
import { isSafeAgentCodeInstalledSkillPath } from '@shared/types/agentCodeInstalledSkills.js'
import type { ExternalAgentSkill, ExternalAgentSkillsSnapshot } from '@shared/types/agentSkills.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { collectInstalledAgentSkills } from './inventory.js'
import { readSkillLock, type SkillLockEntry } from './skillLock.js'

type Service = Pick<AgentCodeManagedSkillsService, 'getPersonalSkillRoots' | 'getInstalledSkillLocations'>

/**
 * Lists personal skills in the provider roots Agent Code writes to that it
 * does NOT manage (#1161) — the "Also found on this machine" section.
 *
 * WHY each root is scanned separately instead of in one collector call: the
 * collector deduplicates by physical file, and `npx skills` installs one real
 * folder plus a symlink per agent root. One call would report the skill in
 * only the first root; the grid needs every root it is visible in (that is
 * what decides which provider columns see it).
 *
 * WHY "managed" comes from the service's installed locations: only the
 * ownership journal can attribute a file to Agent Code (names and markers are
 * public). Everything else in these roots is external by definition.
 */
export async function collectExternalAgentSkills(
  service: Service,
  options: { readLock?: () => Promise<Map<string, SkillLockEntry>> } = {},
): Promise<ExternalAgentSkillsSnapshot> {
  const roots = await service.getPersonalSkillRoots()
  const providers = [...new Set(roots.flatMap(root => root.providers))]
  const managed = { paths: [] as string[], notices: [] as string[] }
  for (const provider of providers) {
    const locations = await service.getInstalledSkillLocations(provider)
    managed.paths.push(...locations.paths)
    managed.notices.push(...locations.notices)
  }
  const lock = await (options.readLock ?? (() => readSkillLock()))()
  const byName = new Map<string, ExternalAgentSkill>()
  const notices = [...new Set(managed.notices)]
  for (const root of roots) {
    const snapshot = await collectInstalledAgentSkills(
      {
        roots: [{
          path: root.skillsDirectory,
          source: 'personal',
          layout: 'children',
          // Claude tolerates missing frontmatter in personal skills; being
          // lenient here only affects what is LISTED, never what is managed.
          optionalFrontmatter: true,
        }],
        notices: [],
      },
      managed,
    )
    notices.push(...snapshot.notices)
    for (const skill of snapshot.skills) {
      if (skill.source === 'agent-code') continue
      const folder = basename(dirname(skill.path))
      const linked = (await lstat(join(root.skillsDirectory, folder)).catch(() => null))?.isSymbolicLink() === true
      const existing = byName.get(skill.name)
      const location = {
        targetId: root.id,
        providers: [...root.providers] as AgentProviderKind[],
        folder,
        displayPath: `${root.displayPath}/${folder}`,
        linked,
      }
      if (existing) {
        existing.locations.push(location)
        continue
      }
      const provenance = lock.get(skill.name) ?? lock.get(folder)
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        locations: [location],
        ...(provenance
          ? { provenance: { installer: 'npx skills' as const, source: provenance.source, ...(provenance.sourceUrl ? { sourceUrl: provenance.sourceUrl } : {}) } }
          : {}),
      })
    }
  }
  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    notices: [...new Set(notices)],
  }
}

/**
 * Resolves the folder to reveal for an external skill from a stable root id
 * and a single folder name — never from a renderer-supplied path (the
 * managed-skills rule "never accept an arbitrary renderer path").
 */
export async function resolveExternalSkillFolder(
  service: Pick<AgentCodeManagedSkillsService, 'getPersonalSkillRoots'>,
  targetId: string,
  folder: string,
): Promise<string | null> {
  if (!isSafeAgentCodeInstalledSkillPath(folder) || folder.includes('/')) return null
  const root = (await service.getPersonalSkillRoots()).find(value => value.id === targetId)
  return root ? join(root.skillsDirectory, folder) : null
}
