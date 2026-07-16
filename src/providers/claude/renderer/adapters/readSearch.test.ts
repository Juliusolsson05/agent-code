import { describe, expect, it } from 'vitest'

import readFixture from '../../../../../testing/fixtures/rendering-shapes/claude/read/final.json'
import toolSearchFixture from '../../../../../testing/fixtures/rendering-shapes/claude/tool-search/final.json'
import {
  fromClaudeReadResult,
  fromClaudeReadUse,
  fromClaudeToolSearchResult,
  fromClaudeToolSearchUse,
  stripClaudeReadGutter,
} from '@providers/claude/renderer/adapters/readSearch'
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

describe('Claude read adapter — captured grammar only', () => {
  it('keeps the curated fixture inside the cataloged Read structure', () => {
    // Fixture paths are part of the catalog's review surface, but the path
    // alone cannot prove the JSON still denotes a structure seen in evidence.
    // Pinning through the production fingerprint closes that drift route.
    expect(CLAUDE_RENDER_SHAPES['claude.tool-use.read.v1'].fingerprints).toContain(
      committedToolUseFingerprint(readFixture.toolUse),
    )
  })

  it('maps the curated path/range fixture without inventing range semantics', () => {
    expect(fromClaudeReadUse(use(readFixture.toolUse))).toEqual({
      path: '/workspace/src/example.ts',
      offset: 41,
      limit: 2,
    })
  })

  it('maps paired string output and computes a bounded summary count', () => {
    const model = fromClaudeReadResult(result(readFixture.toolResult), use(readFixture.toolUse))
    expect(model).toMatchObject({
      path: '/workspace/src/example.ts',
      lineCount: 2,
      lineCountTruncated: false,
      operationId: 'read-fixture-1',
    })
    // The adapter keeps the exact source. Gutter removal belongs to the
    // admitted CodeBlock page so a closed large result never gets copied.
    expect(model?.content).toBe(readFixture.toolResult.content)
    expect(stripClaudeReadGutter(model!.content)).toBe(
      'export const answer = 42\nexport type Answer = number',
    )
  })

  it('declines wrong names, missing paths, mismatched pairs, arrays, and errors', () => {
    expect(fromClaudeReadUse(use({ ...readFixture.toolUse, name: 'Grep' }))).toBeNull()
    expect(
      fromClaudeReadUse(use({ ...readFixture.toolUse, input: { file_path: '   ' } })),
    ).toBeNull()
    expect(
      fromClaudeReadResult(
        result({ ...readFixture.toolResult, tool_use_id: 'someone-else' }),
        use(readFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeReadResult(
        result({
          ...readFixture.toolResult,
          content: [{ type: 'text', text: 'x' }],
        }),
        use(readFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeReadResult(
        result({ ...readFixture.toolResult, is_error: true }),
        use(readFixture.toolUse),
      ),
    ).toBeNull()
  })

  it('bounds display paths while preserving both ownership and extension', () => {
    const rawPath = `/workspace/${'nested/'.repeat(400)}important.ts`
    const model = fromClaudeReadUse(use({ ...readFixture.toolUse, input: { file_path: rawPath } }))!
    expect(model.path.length).toBe(2_048)
    expect(model.path.startsWith('/workspace/')).toBe(true)
    expect(model.path.endsWith('important.ts')).toBe(true)
  })

  it('declines non-integral and unsafe range values instead of rounding provider input', () => {
    expect(
      fromClaudeReadUse(
        use({
          ...readFixture.toolUse,
          input: { file_path: '/workspace/example.ts', offset: 1.5, limit: 2 ** 53 },
        }),
      ),
    ).toMatchObject({ offset: null, limit: null })
  })
})

describe('Claude ToolSearch adapter — structured references', () => {
  it('keeps the curated fixture inside the cataloged ToolSearch structure', () => {
    expect(CLAUDE_RENDER_SHAPES['claude.tool-use.toolsearch.v1'].fingerprints).toContain(
      committedToolUseFingerprint(toolSearchFixture.toolUse),
    )
  })

  it('maps the curated invocation and structured result', () => {
    expect(fromClaudeToolSearchUse(use(toolSearchFixture.toolUse))).toEqual({
      query: 'select:ExampleTool',
      maxResults: 2,
    })
    expect(
      fromClaudeToolSearchResult(
        result(toolSearchFixture.toolResult),
        use(toolSearchFixture.toolUse),
      ),
    ).toEqual({
      query: 'select:ExampleTool',
      maxResults: 2,
      tools: ['ExampleTool', 'ExampleToolTwo'],
      toolsTruncated: false,
    })
  })

  it('declines malformed admitted references instead of partially claiming output', () => {
    expect(
      fromClaudeToolSearchResult(
        result({
          ...toolSearchFixture.toolResult,
          content: [
            { type: 'tool_reference', tool_name: 'Good' },
            { type: 'text', text: 'bad' },
          ],
        }),
        use(toolSearchFixture.toolUse),
      ),
    ).toBeNull()
  })

  it('bounds provider-sized result arrays and reports an honest lower bound', () => {
    const content = Array.from({ length: 80 }, (_, index) => ({
      type: 'tool_reference',
      tool_name: `Tool${index}`,
    }))
    const model = fromClaudeToolSearchResult(
      result({ ...toolSearchFixture.toolResult, content }),
      use(toolSearchFixture.toolUse),
    )!
    expect(model.tools).toHaveLength(50)
    expect(model.toolsTruncated).toBe(true)
  })

  it('does not present a fractional result cap as an exact provider limit', () => {
    expect(
      fromClaudeToolSearchUse(
        use({
          ...toolSearchFixture.toolUse,
          input: { query: 'select:ExampleTool', max_results: 1.5 },
        }),
      ),
    ).toMatchObject({ maxResults: null })
  })
})
