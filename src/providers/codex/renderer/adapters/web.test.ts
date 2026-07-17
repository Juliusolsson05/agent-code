import { describe, expect, it } from 'vitest'

import { fromCodexWebUse } from '@providers/codex/renderer/adapters/web'
import type { ToolUseBlock } from '@shared/types/transcript'

function block(input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: 'web-1', name: 'web_search', input }
}

describe('Codex web adapter', () => {
  it('maps search, open, and find operations without sharing Codex wire grammar', () => {
    expect(fromCodexWebUse(block({ kind: 'search', query: 'Agent Code renderer' }))).toMatchObject({
      operation: 'search',
      label: 'Agent Code renderer',
      url: null,
    })
    expect(fromCodexWebUse(block({ kind: 'open_page', url: 'https://example.com/docs' }))).toMatchObject({
      operation: 'open-page',
      url: 'https://example.com/docs',
    })
    expect(fromCodexWebUse(block({
      kind: 'find_in_page',
      url: 'https://example.com/docs',
      pattern: 'renderOperation',
    }))).toMatchObject({
      operation: 'find-in-page',
      label: 'renderOperation',
    })
  })

  it('declines unsafe URLs but truthfully degrades old find records that lost their pattern', () => {
    expect(fromCodexWebUse(block({ kind: 'open_page', url: 'javascript:alert(1)' }))).toBeNull()
    expect(fromCodexWebUse(block({
      kind: 'find_in_page',
      url: 'https://example.com/docs',
    }))).toMatchObject({ operation: 'find-in-page', label: 'Find in page' })
  })
})
