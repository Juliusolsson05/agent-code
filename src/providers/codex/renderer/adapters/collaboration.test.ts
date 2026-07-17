import { describe, expect, it } from 'vitest'

import { fromCodexNativeSpawnUse } from '@providers/codex/renderer/adapters/collaboration'
import type { ToolUseBlock } from '@shared/types/transcript'

function spawn(input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input }
}

describe('Codex native spawn adapter', () => {
  it('accepts the frozen legacy and current named-task generations', () => {
    expect(fromCodexNativeSpawnUse(spawn({
      agent_type: 'worker',
      message: 'Inspect the old recording',
      reasoning_effort: 'high',
    }))).toMatchObject({
      agentType: 'worker',
      variant: 'legacy-agent-type',
    })
    expect(fromCodexNativeSpawnUse(spawn({
      task_name: 'web_review',
      message: 'Inspect current web behavior',
      fork_turns: 'all',
    }))).toMatchObject({
      agentType: 'web_review',
      variant: 'named-task',
    })
  })

  it('declines an unrecognized identity grammar to structured JSON', () => {
    expect(fromCodexNativeSpawnUse(spawn({
      worker: 'mystery',
      message: 'Do not guess this schema',
    }))).toBeNull()
  })
})
