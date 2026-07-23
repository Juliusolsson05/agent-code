import { homedir } from 'os'
import { join, normalize, resolve } from 'path'
import { realpath } from 'fs/promises'

import { listMainProviders } from '@providers/registry.main.js'
import { AGENT_CODE_CONVENTIONS_SKILL_NAME } from '@shared/types/agentCodeConventions.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// See docs/design/agent-code-conventions.md for why discovery paths are
// provider-owned capabilities while filesystem mutation is centralized.

export type AgentCodeConventionsTarget = {
  id: string
  providers: AgentProviderKind[]
  providerNames: string[]
  skillsDirectory: string
  skillDirectory: string
  skillFile: string
}

export type ResolvedAgentCodeConventionsTargets = {
  targets: AgentCodeConventionsTarget[]
  unsupportedProviders: AgentProviderKind[]
}

export type ResolveAgentCodeConventionsTargetsOptions = {
  homeDirectory?: string
  environment?: Readonly<Record<string, string | undefined>>
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  return normalize(await realpath(absolute).catch(() => absolute))
}

export async function resolveAgentCodeConventionsTargets(
  options: ResolveAgentCodeConventionsTargetsOptions = {},
): Promise<ResolvedAgentCodeConventionsTargets> {
  const context = {
    homeDirectory: options.homeDirectory ?? homedir(),
    environment: options.environment ?? process.env,
  }
  const unsupportedProviders: AgentProviderKind[] = []
  const stableIdPaths = new Map<string, string>()
  const byPhysicalPath = new Map<string, AgentCodeConventionsTarget>()

  for (const provider of listMainProviders()) {
    if (!provider.personalAgentSkills.supported) {
      unsupportedProviders.push(provider.id)
      continue
    }
    if (provider.personalAgentSkills.locations.length === 0) {
      // "Supported" with no discovery root would let a future provider pass
      // the exhaustive capability check while making an all-provider enable a
      // no-op. Fail target resolution so Settings reports degraded instead of
      // presenting a false Active state.
      throw new Error(`${provider.name} declares personal Agent Skills without a location`)
    }
    for (const location of provider.personalAgentSkills.locations) {
      const skillsDirectory = normalize(resolve(location.resolveDirectory(context)))
      const physicalDirectory = await canonicalPath(skillsDirectory)
      const priorPath = stableIdPaths.get(location.id)
      if (priorPath && priorPath !== physicalDirectory) {
        throw new Error(`Personal skill target ${location.id} resolved to multiple directories`)
      }
      stableIdPaths.set(location.id, physicalDirectory)

      const physicalKey = process.platform === 'win32'
        ? physicalDirectory.toLocaleLowerCase('en-US')
        : physicalDirectory
      const existing = byPhysicalPath.get(physicalKey)
      if (existing) {
        if (!existing.providers.includes(provider.id)) existing.providers.push(provider.id)
        if (!existing.providerNames.includes(provider.name)) existing.providerNames.push(provider.name)
        continue
      }

      const skillDirectory = join(skillsDirectory, AGENT_CODE_CONVENTIONS_SKILL_NAME)
      byPhysicalPath.set(physicalKey, {
        id: location.id,
        providers: [provider.id],
        providerNames: [provider.name],
        skillsDirectory,
        skillDirectory,
        skillFile: join(skillDirectory, 'SKILL.md'),
      })
    }
  }

  const targets = [...byPhysicalPath.values()]
  for (const target of targets) {
    target.providers.sort()
    target.providerNames.sort()
  }
  targets.sort((left, right) => left.id.localeCompare(right.id))
  unsupportedProviders.sort()
  return { targets, unsupportedProviders }
}
