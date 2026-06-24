import { describe, expect, it } from 'vitest'

import { buildProviderResumeCommand } from '@renderer/workspace/providerResumeCommand'

describe('buildProviderResumeCommand', () => {
  it('keeps safe cwd and ids unquoted', () => {
    expect(buildProviderResumeCommand('codex', '/tmp/repo', 'abc-123')).toBe(
      'cd /tmp/repo && codex resume abc-123',
    )
    expect(buildProviderResumeCommand('claude', '/tmp/repo', 'abc-123')).toBe(
      'cd /tmp/repo && claude --resume abc-123',
    )
  })

  it('quotes paths and ids with spaces or single quotes', () => {
    expect(buildProviderResumeCommand('codex', '/tmp/my repo', "id'1")).toBe(
      "cd '/tmp/my repo' && codex resume 'id'\\''1'",
    )
  })
})
