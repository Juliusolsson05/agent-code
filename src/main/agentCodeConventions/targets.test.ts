import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { resolveAgentCodeConventionsTargets } from './targets.js'

describe('Agent Code conventions provider targets', () => {
  it('deduplicates physical writes while representing OpenCode overlap', async () => {
    const homeDirectory = join(process.cwd(), '.test-home-that-does-not-exist')
    const claudeConfig = join(homeDirectory, 'custom-claude')
    const result = await resolveAgentCodeConventionsTargets({
      homeDirectory,
      environment: { CLAUDE_CONFIG_DIR: claudeConfig },
    })

    // Contract since grok (#1014): a registered provider MAY declare personal
    // agent skills unsupported; targets resolution must tolerate it — grok
    // simply never contributes a target row.
    expect(result.unsupportedProviders).toEqual(['grok'])
    expect(result.targets).toHaveLength(2)
    expect(result.targets.find(target => target.id === 'claude-personal-skills')).toMatchObject({
      providers: ['claude', 'opencode'],
      skillsDirectory: join(claudeConfig, 'skills'),
    })
    expect(result.targets.find(target => target.id === 'agents-standard-personal-skills')).toMatchObject({
      // Pi reads ~/.agents/skills too (verified in Stage 0), so it shares
      // this physical target rather than adding a write.
      providers: ['codex', 'opencode', 'pi'],
      skillsDirectory: join(homeDirectory, '.agents', 'skills'),
    })
  })
})
