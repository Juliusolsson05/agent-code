import { describe, expect, it } from 'vitest'

import { managedSkillsUnavailableMessage } from './tldr'

// #1133. This text is the only visible sign that an agent started without a
// requested TLDR/Goal skill. It must name the skill (otherwise the user cannot
// tell which Settings row to open) and name the place to fix it (both outages
// this replaced ended with someone hunting for the cause).
describe('managedSkillsUnavailableMessage', () => {
  it('names one skill and the Settings location', () => {
    expect(managedSkillsUnavailableMessage(['tldr'])).toBe(
      'TLDR skill could not be prepared, so agents started without it. Review Settings › Agents › Custom Skills.',
    )
  })

  it('names both skills in a fixed order whatever order they were reported in', () => {
    expect(managedSkillsUnavailableMessage(['goal', 'tldr'])).toBe(
      'TLDR and Goal skills could not be prepared, so agents started without them. Review Settings › Agents › Custom Skills.',
    )
  })
})
