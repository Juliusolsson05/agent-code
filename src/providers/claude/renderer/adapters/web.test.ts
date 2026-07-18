import { describe, expect, it } from 'vitest'

import webFetchFixture from '../../../../../testing/fixtures/rendering-shapes/claude/web-fetch/final.json'
import webSearchFixture from '../../../../../testing/fixtures/rendering-shapes/claude/web-search/final.json'
import {
  fromClaudeWebFetchResult,
  fromClaudeWebFetchUse,
  fromClaudeWebSearchResult,
  fromClaudeWebSearchUse,
} from '@providers/claude/renderer/adapters/web'
import { CLAUDE_RENDER_SHAPES } from '@providers/claude/renderer/shapes'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

const use = (value: unknown) => value as ToolUseBlock
const result = (value: unknown) => value as ToolResultBlock

function committedToolUseFingerprint(payload: unknown): string {
  return fingerprintRenderShape({
    provider: 'claude',
    plane: 'committed-tool-use',
    eventType: 'tool_use',
    payload,
  }).fingerprint
}

describe('Claude WebFetch adapter — fresh captured grammar', () => {
  it('pins the curated fixture to the cataloged committed structure', () => {
    expect(CLAUDE_RENDER_SHAPES['claude.tool-use.webfetch.v1'].fingerprints).toContain(
      committedToolUseFingerprint(webFetchFixture.toolUse),
    )
  })

  it('admits http(s), hides query material from the label, and keeps the exact target', () => {
    expect(fromClaudeWebFetchUse(use(webFetchFixture.toolUse))).toEqual({
      url: 'https://example.com/docs/rendering?view=full',
      urlLabel: 'example.com/docs/rendering',
      prompt: 'Summarize the documented rendering contract.',
    })
  })

  it('maps only a paired, successful string result', () => {
    const model = fromClaudeWebFetchResult(
      result(webFetchFixture.toolResult),
      use(webFetchFixture.toolUse),
    )
    expect(model).toMatchObject({
      urlLabel: 'example.com/docs/rendering',
      lineCount: 5,
      lineCountTruncated: false,
      content: webFetchFixture.toolResult.content,
    })
    expect(
      fromClaudeWebFetchResult(
        result({ ...webFetchFixture.toolResult, tool_use_id: 'other' }),
        use(webFetchFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeWebFetchResult(
        result({ ...webFetchFixture.toolResult, is_error: true }),
        use(webFetchFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeWebFetchResult(
        result({ ...webFetchFixture.toolResult, content: [{ type: 'text', text: 'future' }] }),
        use(webFetchFixture.toolUse),
      ),
    ).toBeNull()
  })

  it('declines unsafe/oversized URLs and incomplete fetch prompts', () => {
    expect(
      fromClaudeWebFetchUse(
        use({
          ...webFetchFixture.toolUse,
          input: { url: 'file:///private/data', prompt: 'Read it' },
        }),
      ),
    ).toBeNull()
    expect(
      fromClaudeWebFetchUse(
        use({
          ...webFetchFixture.toolUse,
          input: { url: `https://example.com/${'x'.repeat(2_100)}`, prompt: 'Read it' },
        }),
      ),
    ).toBeNull()
    expect(
      fromClaudeWebFetchUse(
        use({
          ...webFetchFixture.toolUse,
          input: { url: 'https://example.com', prompt: '  ' },
        }),
      ),
    ).toBeNull()
  })
})

describe('Claude WebSearch adapter — fresh captured grammar', () => {
  it('pins the curated fixture to the cataloged committed structure', () => {
    expect(CLAUDE_RENDER_SHAPES['claude.tool-use.websearch.v1'].fingerprints).toContain(
      committedToolUseFingerprint(webSearchFixture.toolUse),
    )
  })

  it('maps the invocation and paired string result', () => {
    expect(fromClaudeWebSearchUse(use(webSearchFixture.toolUse))).toEqual({
      query: 'evidence backed rendering',
    })
    expect(
      fromClaudeWebSearchResult(result(webSearchFixture.toolResult), use(webSearchFixture.toolUse)),
    ).toMatchObject({
      query: 'evidence backed rendering',
      lineCount: 4,
      lineCountTruncated: false,
      content: webSearchFixture.toolResult.content,
    })
  })

  it('bounds visible queries and declines missing, mismatched, error, and non-string evidence', () => {
    const longQuery = `start ${'middle '.repeat(200)}finish`
    const bounded = fromClaudeWebSearchUse(
      use({ ...webSearchFixture.toolUse, input: { query: longQuery } }),
    )!
    expect(bounded.query).toHaveLength(1_000)
    expect(bounded.query.startsWith('start ')).toBe(true)
    expect(bounded.query.endsWith('finish')).toBe(true)

    expect(
      fromClaudeWebSearchUse(use({ ...webSearchFixture.toolUse, input: { query: '' } })),
    ).toBeNull()
    expect(
      fromClaudeWebSearchResult(
        result({ ...webSearchFixture.toolResult, tool_use_id: 'other' }),
        use(webSearchFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeWebSearchResult(
        result({ ...webSearchFixture.toolResult, is_error: true }),
        use(webSearchFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeWebSearchResult(
        result({ ...webSearchFixture.toolResult, content: null }),
        use(webSearchFixture.toolUse),
      ),
    ).toBeNull()
  })
})
