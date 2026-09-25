import { join, resolve } from 'node:path'

import { ancestorsThrough, findAncestorWithMarker } from '@providers/shared/runtime/skillDiscovery.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext, AgentSkillRoot } from '@shared/types/agentSkills.js'

/**
 * Pi skill roots.
 *
 * Source of truth: earendil-works/pi@96724621 packages/coding-agent
 * `package-manager.ts` (resource discovery) and `skills.ts`:
 * - `<agentDir>/skills` (agentDir = $PI_CODING_AGENT_DIR or ~/.pi/agent) and
 *   `~/.agents/skills` — personal, always loaded. Stage 0 verified Pi picks up
 *   Agent Code's managed skills from `~/.agents/skills`.
 * - project `.pi/skills` (the cwd only) and `.agents/skills` in the cwd and
 *   every ancestor up to the git root — loaded ONLY for trusted projects.
 * - The walk is recursive, skips dot entries and node_modules, and treats a
 *   directory holding `SKILL.md` as a leaf.
 *
 * Not modelled: Pi also accepts bare `*.md` files directly inside a `.pi`
 * skills root as skills. Agent Code's collector reads `SKILL.md` skills only,
 * which is the format every managed skill uses; a loose .md skill simply does
 * not appear in the inventory (it still works inside pi).
 */
export async function discoverPiSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { cwd, homeDirectory: home, environment } = context
  const fromEnv = environment.PI_CODING_AGENT_DIR
  const agentDir = fromEnv ? resolve(fromEnv.startsWith('~/') ? join(home, fromEnv.slice(2)) : fromEnv) : join(home, '.pi', 'agent')
  const recursive = { layout: 'recursive', includeHidden: false } as const
  const roots: AgentSkillRoot[] = [
    { path: join(agentDir, 'skills'), source: 'personal', ...recursive },
    { path: join(home, '.agents', 'skills'), source: 'personal', ...recursive },
    { path: join(cwd, '.pi', 'skills'), source: 'project', sourceLabel: 'Project (trusted projects only)', ...recursive },
  ]
  const gitRoot = await findAncestorWithMarker(cwd, ['.git'])
  for (const directory of ancestorsThrough(cwd, gitRoot)) {
    roots.push({ path: join(directory, '.agents', 'skills'), source: 'project', sourceLabel: 'Project (trusted projects only)', ...recursive })
  }
  return {
    roots,
    notices: ['Pi loads project skills (.pi/skills, .agents/skills) only after you trust the project in Pi.'],
  }
}
