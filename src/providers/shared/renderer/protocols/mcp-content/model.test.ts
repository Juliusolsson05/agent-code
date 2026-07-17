import { describe, expect, it } from 'vitest'

import {
  isMcpContentCarrier,
  mcpContentCounts,
  parseMcpContentResult,
} from './model'

describe('MCP typed content model', () => {
  it('parses the standard open content block set', () => {
    const raw = {
      isError: false,
      structuredContent: { ok: true },
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'audio', mimeType: 'audio/wav', data: 'aGVsbG8=' },
        { type: 'resource', resource: { uri: 'file:///tmp/report.txt', text: 'report' } },
        { type: 'resource_link', uri: 'https://example.com', name: 'Example' },
      ],
    }
    const model = parseMcpContentResult(raw)
    expect(model?.blocks.map(block => block.type)).toEqual([
      'text', 'image', 'audio', 'resource', 'resource_link',
    ])
    expect(model?.structuredContent).toEqual({ ok: true })
    expect(mcpContentCounts(model!)).toContain('1 image')
  })

  it('recognizes serialized CallToolResult but not arbitrary content arrays', () => {
    const carrier = { content: [{ type: 'text', text: 'hello' }] }
    expect(isMcpContentCarrier(carrier)).toBe(true)
    expect(parseMcpContentResult(JSON.stringify(carrier))).not.toBeNull()
    expect(parseMcpContentResult({ content: [{ value: 1 }] })).toBeNull()
  })

  it('requires explicit admission for a direct transcript content array', () => {
    const direct = [{ type: 'image', mimeType: 'image/png', data: 'aA==' }]
    expect(parseMcpContentResult(direct)).toBeNull()
    expect(parseMcpContentResult(direct, { allowDirectArray: true })).not.toBeNull()
  })
})
