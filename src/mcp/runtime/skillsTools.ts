import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { AgentCodeManagedSkillsService } from '@main/agentCodeConventions/AgentCodeManagedSkillsService.js'
import type { McpSessionScope } from '@mcp/shared/types.js'
import type { ExternalAgentSkillsSnapshot } from '@shared/types/agentSkills.js'
import type {
  AgentCodeInstalledSkill,
  AgentCodeInstalledSkillsMutationResult,
} from '@shared/types/agentCodeInstalledSkills.js'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind.js'

/**
 * The `skills` built-in domain (#1161): lets an agent find and PROPOSE
 * personal skills — "install the pdf skill from anthropics/skills for me".
 *
 * WHY tools over the managed-skills service instead of letting the agent run
 * `npx skills add`: the CLI would write straight into provider roots, where
 * every later Agent Code install of that name becomes an unresolvable
 * collision, and nothing would ask the user first. Going through the service
 * gives the agent the exact discovery, review and ownership rules the
 * Settings UI has.
 *
 * WHY an agent can only propose (the #1143 rule for MCP servers): a skill is
 * instructions every future agent may load, possibly with executable
 * scripts. Proposals are saved switched OFF with `pendingReview`, nothing is
 * written to provider roots, and only the user enabling it in Settings →
 * Skills makes it live. There is deliberately no enable tool, and removal is
 * limited to the agent-side of that contract: withdrawing a proposal.
 */
export type SkillsToolDependencies = {
  managedSkills?: Pick<
    AgentCodeManagedSkillsService,
    'getInstalledSkillsSnapshot' | 'getCustomSkillsSnapshot' | 'discoverGitHubSkills' | 'installGitHubSkills' | 'deleteInstalledSkill'
  >
  listExternalSkills?: () => Promise<ExternalAgentSkillsSnapshot>
  /** Tells every window that an agent changed the managed skills. */
  onSkillsChangedByAgent?: (event: { sessionId: string; message: string }) => void
}

export const SKILLS_INSTRUCTIONS = `Skills lets you find and propose personal Agent Skills for the user in Agent Code (skills every new Claude, Codex, OpenCode and Pi agent can load). Only propose skills when the user's current request asks for it; never on your own initiative. Accept exactly what the user or the skill's documentation gives you: an \`npx skills add owner/repo --skill name\` command, owner/repo, owner/repo@skill, or a GitHub or skills.sh URL. Use skills_find first to see what a source contains, then skills_add with the skill names. A skill you add is saved switched OFF, waiting for the user's review; nothing reaches any agent until the user turns it on in Settings → Skills. You cannot turn a skill on. Tell the user what you proposed, mention any warnings (for example executable scripts), and ask them to review it. Never run \`npx skills\` or write into ~/.claude/skills or ~/.agents/skills yourself: those folders are managed by Agent Code, and files written there bypass the user's review. Report exactly what you changed.`

const PROVIDER_ENUM = z.enum(AGENT_PROVIDER_KINDS as unknown as [AgentProviderKind, ...AgentProviderKind[]])

export function registerSkillsTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: SkillsToolDependencies,
): void {
  const service = () => {
    if (!dependencies.managedSkills) throw new Error('Skill management is unavailable.')
    return dependencies.managedSkills
  }
  const failure = (message: string) => ({ ...toolText({ ok: false, message }), isError: true })
  const caught = (error: unknown) => failure(error instanceof Error ? error.message : 'Skill change failed.')
  const changed = (message: string) => dependencies.onSkillsChangedByAgent?.({ sessionId: scope.sessionId, message })

  server.registerTool('skills_list', {
    title: 'List skills',
    description: 'List the user\'s personal skills: the ones Agent Code manages (installed from sources, and written in Agent Code), whether each is on, waiting for review, and which providers get it, plus skills other tools installed on this machine (read-only).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const [installed, custom, external] = await Promise.all([
        service().getInstalledSkillsSnapshot(),
        service().getCustomSkillsSnapshot(),
        dependencies.listExternalSkills?.() ?? Promise.resolve({ skills: [], notices: [] }),
      ])
      return toolText({
        ok: true,
        installed: installed.skills.map(describeInstalled),
        writtenInAgentCode: custom.skills.map(skill => ({
          name: skill.name,
          description: skill.description,
          enabled: skill.enabled,
          providers: skill.providers ?? 'all',
          ...(skill.managedBy ? { managedBy: skill.managedBy } : {}),
        })),
        foundOnThisMachine: external.skills.map(skill => ({
          name: skill.name,
          description: skill.description,
          folders: skill.locations.map(location => location.displayPath),
          ...(skill.provenance ? { installedBy: skill.provenance.installer, source: skill.provenance.source } : {}),
        })),
      })
    } catch (error) {
      return caught(error)
    }
  })

  server.registerTool('skills_find', {
    title: 'Find skills in a source',
    description: 'Show which skills a source contains without installing anything. Accepts an `npx skills add …` command, owner/repo, owner/repo@skill, owner/repo/path, owner/repo#ref, or a GitHub or skills.sh URL. GitHub sources only.',
    inputSchema: {
      source: z.string().min(1).max(4096).describe('The install command or source, exactly as documented.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source }) => {
    try {
      const result = await service().discoverGitHubSkills(source)
      if (!result.ok) return failure(result.message)
      return toolText({
        ok: true,
        repository: result.discovery.repositoryUrl,
        ref: result.discovery.requestedRef,
        commit: result.discovery.resolvedCommit,
        skills: result.discovery.candidates.map(candidate => ({
          name: candidate.name,
          description: candidate.description,
          path: candidate.source.path || '(repository root)',
          files: candidate.files.length,
          warnings: candidate.warnings,
        })),
        notFound: result.discovery.missingSkills,
        notices: result.discovery.notices,
      })
    } catch (error) {
      return caught(error)
    }
  })

  server.registerTool('skills_add', {
    title: 'Propose skills',
    description: 'Propose skills from a source for the user to review. They are saved switched OFF and reach no agent until the user turns them on in Settings → Skills. Name the skills to add (from skills_find) unless the source already names them (--skill or @skill). Returns what was proposed.',
    inputSchema: {
      source: z.string().min(1).max(4096).describe('The install command or source, exactly as documented.'),
      skills: z.array(z.string().min(1).max(128)).optional()
        .describe('Skill names to propose. Omit only when the source names them.'),
      providers: z.array(PROVIDER_ENUM).min(1).optional()
        .describe('Providers whose agents should get the skills once approved. Defaults to the command\'s -a list, else every provider.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ source, skills, providers }) => {
    try {
      const found = await service().discoverGitHubSkills(source)
      if (!found.ok) return failure(found.message)
      const discovery = found.discovery
      const wanted = skills?.map(name => name.toLowerCase())
      const selected = wanted
        ? discovery.candidates.filter(candidate => wanted.includes(candidate.name.toLowerCase())
          || wanted.includes((candidate.source.path.split('/').pop() ?? '').toLowerCase()))
        : discovery.selection.skills !== null || discovery.candidates.length === 1
          ? discovery.candidates
          : null
      if (!selected) {
        return failure(`This source contains ${discovery.candidates.length} skills. Name the ones to propose (see skills_find).`)
      }
      if (selected.length === 0) {
        return failure(`None of ${skills!.join(', ')} is in this source. Use skills_find to see its skills.`)
      }
      const chosenProviders = providers
        ?? (Array.isArray(discovery.selection.providers) && discovery.selection.providers.length > 0
          ? discovery.selection.providers
          : undefined)
      const current = await service().getInstalledSkillsSnapshot()
      const result = await service().installGitHubSkills({
        expectedRevision: current.revision,
        discoveryId: discovery.discoveryId,
        candidateIds: selected.map(candidate => candidate.candidateId),
        ...(chosenProviders ? { providers: chosenProviders } : {}),
      }, {
        pendingReview: { by: 'agent', sessionId: scope.sessionId, requestedAt: new Date().toISOString() },
      })
      if (!result.ok) return failure(mutationFailure(result))
      const names = selected.map(candidate => candidate.name)
      changed(`An agent proposed skill${names.length === 1 ? '' : 's'} ${names.join(', ')} for your review`)
      return toolText({
        ok: true,
        proposed: result.snapshot.skills.filter(skill => names.includes(skill.name)).map(describeInstalled),
        next: 'The user must review and turn these on in Settings → Skills before any agent gets them.',
      })
    } catch (error) {
      return caught(error)
    }
  })

  server.registerTool('skills_remove', {
    title: 'Withdraw a proposed skill',
    description: 'Withdraw a skill that an agent proposed and the user has not reviewed yet. Skills the user approved can only be removed by the user in Settings → Skills.',
    inputSchema: {
      name: z.string().min(1).max(128),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    try {
      const snapshot = await service().getInstalledSkillsSnapshot()
      const skill = snapshot.skills.find(value => value.name === name)
      if (!skill) return failure(`No installed skill is named ${name}.`)
      // WHY only pending proposals: removing a skill the user reviewed would
      // silently change every future agent's instructions. Withdrawing a
      // proposal only undoes the agent's own unreviewed request.
      if (!skill.pendingReview || skill.enabled) {
        return failure(`${name} was reviewed by the user. Ask the user to remove it in Settings → Skills.`)
      }
      const result = await service().deleteInstalledSkill({ expectedRevision: snapshot.revision, skillId: skill.id })
      if (!result.ok) return failure(mutationFailure(result))
      changed(`An agent withdrew its proposed skill ${name}`)
      return toolText({ ok: true, removed: name })
    } catch (error) {
      return caught(error)
    }
  })
}

function describeInstalled(skill: AgentCodeInstalledSkill) {
  return {
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    ...(skill.pendingReview ? { waitingForUserReview: true } : {}),
    providers: skill.providers ?? 'all',
    source: `${skill.source.owner}/${skill.source.repository}${skill.source.path ? `/${skill.source.path}` : ''}@${skill.source.resolvedCommit.slice(0, 12)}`,
    health: skill.health,
    warnings: skill.warnings,
  }
}

function mutationFailure(result: Exclude<AgentCodeInstalledSkillsMutationResult, { ok: true }>): string {
  if ('message' in result) return result.message
  if (result.code === 'revision-conflict') return 'Skills changed at the same time. Try again.'
  if (result.code === 'unsupported') return 'No provider supports personal skills.'
  return 'Managed skill state needs the user\'s attention in Settings → Skills.'
}

function toolText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}
