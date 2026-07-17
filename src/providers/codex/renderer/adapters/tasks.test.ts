import { describe, expect, it } from 'vitest'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { fromCodexPlanUse, isCodexPlanResult } from './tasks'

describe('Codex plan adapter', () => {
  const block: ToolUseBlock = {
    type: 'tool_use',
    id: 'plan',
    name: 'update_plan',
    input: {
      explanation: 'Rendering rewrite progress',
      plan: [
        { step: 'Audit evidence', status: 'completed' },
        { step: 'Implement tasks', status: 'in_progress' },
        { step: 'Run replay', status: 'pending' },
      ],
    },
  }

  it('parses stable plan steps and exact counts', () => {
    expect(fromCodexPlanUse(block)).toMatchObject({
      explanation: 'Rendering rewrite progress',
      totalItems: 3,
      completedItems: 1,
      activeItems: 1,
    })
  })

  it('declines malformed or unknown-status plans', () => {
    expect(fromCodexPlanUse({ ...block, input: { plan: [] } })).toBeNull()
    expect(fromCodexPlanUse({
      ...block,
      input: { plan: [{ step: 'Paused', status: 'paused' }] },
    })).toBeNull()
  })

  it('absorbs only the captured acknowledgement', () => {
    const model = fromCodexPlanUse(block)!
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'Plan updated',
    }
    expect(isCodexPlanResult(result, model)).toBe(true)
    expect(isCodexPlanResult({ ...result, content: 'ok' }, model)).toBe(false)
  })
})
