import { join } from 'node:path'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext } from '@shared/types/agentSkills.js'

export async function discoverOpencodeSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { homeDirectory: home, environment, projectDirectories } = context
  const roots: AgentSkillDiscovery['roots'] = [
    { path: join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'skills'), source: 'personal' },
    ...projectDirectories.map(path => ({ path: join(path, '.opencode', 'skills'), source: 'project' as const })),
  ]
  // https://opencode.ai/docs/skills/ documents three namespaces. Compatibility
  // roots are not copies owned by OpenCode; physical deduplication happens in
  // the read-only collector so a shared Agent Code deployment appears once.
  if (environment.OPENCODE_DISABLE_EXTERNAL_SKILLS !== 'true'
    && environment.OPENCODE_DISABLE_EXTERNAL_SKILLS !== '1') {
    for (const name of ['.agents', '.claude']) {
      roots.push({ path: join(home, name, 'skills'), source: 'personal' })
      roots.push(...projectDirectories.map(path => ({
        path: join(path, name, 'skills'), source: 'project' as const,
      })))
    }
  }
  if (environment.OPENCODE_CONFIG_DIR) {
    roots.push({ path: join(environment.OPENCODE_CONFIG_DIR, 'skills'), source: 'personal' })
  }
  return {
    roots,
    notices: ['OpenCode remote and extra configured skill sources are not included; this lists its default local skill directories.'],
  }
}
