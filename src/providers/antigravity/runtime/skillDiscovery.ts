import { join } from 'node:path'

import { ancestorsThrough, findAncestorWithMarker } from '@providers/shared/runtime/skillDiscovery.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext, AgentSkillRoot } from '@shared/types/agentSkills.js'

/**
 * Antigravity (agy) skill roots.
 *
 * Source of truth: agy 1.5.15's own built-in guidance (strings in the shipped
 * binary): workspace skills are `.agents/skills/<name>/SKILL.md`, and a
 * `SKILL.md` without frontmatter or `name` is dropped. agy follows the
 * `.agents` convention up the workspace, so the cwd and its ancestors up to
 * the git root are listed, like Pi's `.agents` walk.
 *
 * NOT listed: a personal (global) skills folder. agy's is undocumented, and
 * the Skills UI must not show a location agy may not read; registry.main.ts
 * declares personal agent skills unsupported for the same reason.
 */
export async function discoverAntigravitySkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { cwd } = context
  const children = { layout: 'children', includeHidden: false } as const
  const roots: AgentSkillRoot[] = []
  const gitRoot = await findAncestorWithMarker(cwd, ['.git'])
  for (const directory of ancestorsThrough(cwd, gitRoot)) {
    roots.push({ path: join(directory, '.agents', 'skills'), source: 'project', ...children })
  }
  return {
    roots,
    notices: ['Antigravity reads project skills from .agents/skills; its personal skill folder is not documented, so none is listed.'],
  }
}
