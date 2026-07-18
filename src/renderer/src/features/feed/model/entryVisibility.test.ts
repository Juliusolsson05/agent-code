import { describe, expect, it } from 'vitest'

import { committedEntryPaints } from './entryVisibility'
import type { ContentBlock, Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { CommittedOperationDecisionResolver } from '@renderer/features/feed/context'

const toolUse: ToolUseBlock = { type: 'tool_use', id: 'tool-1', name: 'exec', input: { raw: 'x' } }
const result: ToolResultBlock = { type: 'tool_result', tool_use_id: 'tool-1', content: '' }

function entry(content: ContentBlock[]): Entry {
  return {
    type: 'user', uuid: 'entry-1', timestamp: '2026-07-18T00:00:00Z',
    message: { role: 'user', content },
  } as Entry
}

describe('committedEntryPaints', () => {
  const absorb: CommittedOperationDecisionResolver = () => ({
    toolUse: { action: 'render', node: null, receipt: { rendererId: 'test' } },
    toolResult: { action: 'absorb', ownerRenderId: 'test', reason: 'paired owner' },
  })

  it('removes an entry whose only block is a proven absorbed result', () => {
    expect(committedEntryPaints({
      entry: entry([result]),
      toolUseIndex: new Map([['tool-1', toolUse]]),
      toolResultIndex: new Map([['tool-1', result]]),
      resolveOperation: absorb,
    })).toBe(false)
  })

  it('keeps orphans, text siblings, and generic results visible', () => {
    const generic: CommittedOperationDecisionResolver = () => ({
      toolUse: { action: 'fallback' },
      toolResult: { action: 'fallback' },
    })
    expect(committedEntryPaints({
      entry: entry([result]), toolUseIndex: new Map(), toolResultIndex: new Map(), resolveOperation: absorb,
    })).toBe(true)
    expect(committedEntryPaints({
      entry: entry([result, { type: 'text', text: 'keep me' }]),
      toolUseIndex: new Map([['tool-1', toolUse]]), toolResultIndex: new Map(), resolveOperation: absorb,
    })).toBe(true)
    expect(committedEntryPaints({
      entry: entry([result]),
      toolUseIndex: new Map([['tool-1', toolUse]]), toolResultIndex: new Map(), resolveOperation: generic,
    })).toBe(true)
  })
})
