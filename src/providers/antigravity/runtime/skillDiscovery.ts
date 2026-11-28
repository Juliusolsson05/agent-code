import { join } from 'node:path'

import { ancestorsThrough, findAncestorWithMarker } from '@providers/shared/runtime/skillDiscovery.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext, AgentSkillRoot } from '@shared/types/agentSkills.js'

/** Google documents these as personal CLI roots. Write managed skills only to the
 * canonical shared config root; also installing them in legacy roots would leave
 * duplicate slash commands and stale copies when the user disables a skill. */
export function antigravityPersonalSkills({ homeDirectory }: Pick<AgentSkillDiscoveryContext, 'homeDirectory'>): string {
  return join(homeDirectory, '.gemini', 'config', 'skills')
}

export async function discoverAntigravitySkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { cwd } = context
  const children = { layout: 'children', includeHidden: false } as const
  const roots: AgentSkillRoot[] = []
  const gitRoot = await findAncestorWithMarker(cwd, ['.git'])
  for (const directory of ancestorsThrough(cwd, gitRoot)) {
    roots.push({ path: join(directory, '.agents', 'skills'), source: 'project', ...children })
  }
  for (const path of [
    antigravityPersonalSkills(context),
    join(context.homeDirectory, '.gemini', 'antigravity-cli', 'skills'),
    join(context.homeDirectory, '.gemini', 'skills'),
  ]) roots.push({ path, source: 'personal', ...children })
  return { roots, notices: [] }
}
