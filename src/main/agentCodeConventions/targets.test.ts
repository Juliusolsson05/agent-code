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

    expect(result.unsupportedProviders).toEqual([])
    expect(result.targets).toHaveLength(2)
    expect(result.targets.find(target => target.id === 'claude-personal-skills')).toMatchObject({
      providers: ['claude', 'opencode'],
      skillsDirectory: join(claudeConfig, 'skills'),
    })
    expect(result.targets.find(target => target.id === 'agents-standard-personal-skills')).toMatchObject({
      providers: ['codex', 'opencode'],
      skillsDirectory: join(homeDirectory, '.agents', 'skills'),
    })
  })
})
