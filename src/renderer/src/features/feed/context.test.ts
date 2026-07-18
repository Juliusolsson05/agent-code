import { describe, expect, it, vi } from 'vitest'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { createCommittedOperationDecisionResolver } from '@renderer/features/feed/context'

const toolUse: ToolUseBlock = {
  type: 'tool_use',
  id: 'tool-1',
  name: 'Read',
  input: { file_path: '/tmp/a.ts' },
}
const result: ToolResultBlock = {
  type: 'tool_result',
  tool_use_id: 'tool-1',
  content: 'ok',
}
const unrelatedToolUse: ToolUseBlock = {
  type: 'tool_use',
  id: 'tool-2',
  name: 'Read',
  input: { file_path: '/tmp/b.ts' },
}
const unrelatedResult: ToolResultBlock = {
  type: 'tool_result',
  tool_use_id: 'tool-2',
  content: 'also ok',
}

describe('committed operation pair decision resolver', () => {
  it('dispatches once for both correlated rows within one index generation', () => {
    const decision = { toolUse: { action: 'fallback' as const }, toolResult: { action: 'fallback' as const } }
    const dispatch = vi.fn(() => decision)
    const resolve = createCommittedOperationDecisionResolver(dispatch)

    expect(resolve(toolUse, result)).toBe(decision)
    expect(resolve(toolUse, result)).toBe(decision)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('keeps older pair decisions across unrelated appends but recomputes on result arrival', () => {
    const dispatch = vi.fn(() => ({
      toolUse: { action: 'fallback' as const },
      toolResult: { action: 'fallback' as const },
    }))
    const resolve = createCommittedOperationDecisionResolver(dispatch)

    resolve(toolUse, null)
    resolve(unrelatedToolUse, unrelatedResult)

    // WHY this call models an index-version append: Feed keeps the resolver but
    // both context maps receive new identities. The original pair's exact block
    // identities did not change, so redispatching it would only repeat work.
    resolve(toolUse, null)
    expect(dispatch).toHaveBeenCalledTimes(2)

    // The correlated result arriving is a real pair transition. Comparing the
    // exact result identity invalidates only this tool use's cached decision.
    resolve(toolUse, result)
    expect(dispatch).toHaveBeenCalledTimes(3)

    resolve(toolUse, result)
    expect(dispatch).toHaveBeenCalledTimes(3)
  })
})
