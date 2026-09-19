import { ipcMain } from 'electron'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { getMainProvider } from '@providers/registry.main.js'
import { asRecord } from '@shared/lib/asRecord.js'
import { isAgentProviderKind } from '@shared/types/providerKind.js'
import type { AgentSkillsSnapshot } from '@shared/types/agentSkills.js'
import type { AgentCodeManagedSkillsService } from '@main/agentCodeConventions/AgentCodeManagedSkillsService.js'
import { collectInstalledAgentSkills } from '@main/agentSkills/inventory.js'

export function registerAgentSkillsIpc(service: AgentCodeManagedSkillsService): void {
  ipcMain.handle('agent-skills:list', async (_event, value: unknown): Promise<AgentSkillsSnapshot> => {
    const request = asRecord(value)
    if (!request || !isAgentProviderKind(request.provider)
      || typeof request.cwd !== 'string' || !isAbsolute(request.cwd)
      || request.cwd.includes('\0') || request.cwd.length > 4096) {
      throw new Error('A valid provider and absolute working directory are required.')
    }
    const discover = getMainProvider(request.provider).discoverSkillRoots
    if (!discover) return { skills: [], notices: ['Skill discovery is not available for this provider.'] }
    // Renderer owns workspace/project metadata even for sleeping agents, so a
    // backend PTY is not required. Only provider-defined discovery locations are
    // derived from cwd; the renderer cannot request arbitrary file contents.
    // Each adapter walks its own ancestry (Claude stops at the nearest .git or
    // home, Codex at its project-root markers, OpenCode at the worktree): the
    // shared precomputed list this used to pass is what let Claude discovery
    // cross the repository boundary.
    const discovery = await discover({
      cwd: request.cwd,
      homeDirectory: homedir(),
      environment: process.env,
    })
    return collectInstalledAgentSkills(discovery, await service.getInstalledSkillLocations(request.provider))
  })
}
