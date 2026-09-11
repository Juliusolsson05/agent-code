import { join } from 'node:path'
import { opendir } from 'node:fs/promises'
import { parse } from '@iarna/toml'
import { asRecord } from '@shared/lib/asRecord.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext } from '@shared/types/agentSkills.js'
import { missingSkillPath, pluginSkillRoots, readSkillFile } from '@providers/shared/runtime/skillDiscovery.js'

export async function discoverCodexSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { homeDirectory: home, environment, projectDirectories } = context
  const codexHome = environment.CODEX_HOME || join(home, '.codex')
  // Sources: https://developers.openai.com/codex/skills/ and the installed
  // Codex system-skill cache. The legacy CODEX_HOME/skills location remains
  // relevant to skill-installer and explicitly includes .system below:
  // blindly skipping every dot-directory loses all provider-default skills.
  const roots: AgentSkillDiscovery['roots'] = [
    ...projectDirectories.map(path => ({ path: join(path, '.agents', 'skills'), source: 'project' as const })),
    { path: join(home, '.agents', 'skills'), source: 'personal' },
    { path: join(codexHome, 'skills'), source: 'personal' },
    { path: join(codexHome, 'skills', '.system'), source: 'system', sourceLabel: 'Codex defaults' },
    { path: '/etc/codex/skills', source: 'system' },
  ]
  const notices: string[] = []
  try {
    const configText = await readSkillFile(join(codexHome, 'config.toml'), 1024 * 1024)
    const config = configText ? parse(configText) : {}
    for (const [id, value] of Object.entries(asRecord(config.plugins) ?? {})) {
      if (asRecord(value)?.enabled !== true) continue
      const match = id.match(/^([a-zA-Z0-9_-][a-zA-Z0-9._-]*)@([a-zA-Z0-9_-][a-zA-Z0-9._-]*)$/)
      if (!match) { notices.push('A configured Codex plugin has an unsupported identifier.'); continue }
      const pluginBase = join(codexHome, 'plugins', 'cache', match[2]!, match[1]!)
      const versions: string[] = []
      let inspected = 0
      try {
        const directory = await opendir(pluginBase)
        for await (const entry of directory) {
          if (++inspected > 256) break
          if (entry.isDirectory() && /^[a-zA-Z0-9_+.-]+$/.test(entry.name)
            && !entry.name.startsWith('.')) versions.push(entry.name)
          if (versions.length > 64) break
        }
      } catch (error) {
        if (!missingSkillPath(error)) notices.push(`Could not inspect installed Codex plugin: ${id}`)
      }
      // Codex's PluginStore replaces an installation's base directory and
      // prefers "local" when present (core-plugins/src/store.rs). A single
      // version is unambiguous. If an older cache has several other versions,
      // leave resolution to Codex rather than invent a semver ordering here.
      const version = inspected > 256 || versions.length > 64 ? null
        : versions.includes('local') ? 'local' : versions.length === 1 ? versions[0] : null
      if (version) {
        roots.push(...await pluginSkillRoots(join(pluginBase, version), match[1]!, '.codex-plugin', notices))
      } else {
        notices.push(`Codex plugin ${id} has no unambiguous local installation; its skills are not included.`)
      }
    }
  } catch {
    notices.push('Could not read Codex skill configuration.')
  }
  notices.push('Codex cloud-managed and project-configured plugins may expose additional skills beyond this local inventory.')
  return { roots, notices }
}
