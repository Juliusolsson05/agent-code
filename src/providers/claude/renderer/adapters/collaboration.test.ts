import { describe, expect, it } from 'vitest'

import agentFixture from '../../../../../testing/fixtures/rendering-shapes/claude/agent/final.json'
import {
  fromClaudeAgentResult,
  fromClaudeAgentUse,
} from '@providers/claude/renderer/adapters/collaboration'
import { CLAUDE_RENDER_SHAPES } from '@providers/claude/renderer/shapes'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

const use = (value: unknown) => value as ToolUseBlock
const result = (value: unknown) => value as ToolResultBlock

describe('Claude Agent adapter — fresh captured collaboration grammar', () => {
  it('pins the curated fixture to an existing cataloged Agent structure', () => {
    const fingerprint = fingerprintRenderShape({
      provider: 'claude',
      plane: 'committed-tool-use',
      eventType: 'tool_use',
      payload: agentFixture.toolUse,
    }).fingerprint
    expect(CLAUDE_RENDER_SHAPES['claude.tool-use.agent.v1'].fingerprints).toContain(fingerprint)
  })

  it('maps the required invocation fields and optional background flag', () => {
    expect(fromClaudeAgentUse(use(agentFixture.toolUse))).toEqual({
      operationId: 'agent-fixture-1',
      agentType: 'Explore',
      description: 'Inspect renderer ownership',
      prompt:
        'Inspect the provider rendering boundary and report the relevant ownership invariants.',
      background: false,
    })
    expect(
      fromClaudeAgentUse(
        use({
          ...agentFixture.toolUse,
          input: { ...agentFixture.toolUse.input, run_in_background: true },
        }),
      ),
    ).toMatchObject({ background: true })
  })

  it('maps a fully understood paired text-block result', () => {
    expect(
      fromClaudeAgentResult(result(agentFixture.toolResult), use(agentFixture.toolUse)),
    ).toEqual({
      texts: ['The provider dispatcher owns the validated Agent shape.'],
    })
  })

  it('declines incomplete uses and unknown optional-flag variants', () => {
    expect(fromClaudeAgentUse(use({ ...agentFixture.toolUse, id: '' }))).toBeNull()
    expect(
      fromClaudeAgentUse(
        use({
          ...agentFixture.toolUse,
          input: { ...agentFixture.toolUse.input, description: '' },
        }),
      ),
    ).toBeNull()
    expect(
      fromClaudeAgentUse(
        use({
          ...agentFixture.toolUse,
          input: { ...agentFixture.toolUse.input, run_in_background: 'yes' },
        }),
      ),
    ).toBeNull()
  })

  it('declines results it cannot absorb completely', () => {
    expect(
      fromClaudeAgentResult(
        result({ ...agentFixture.toolResult, tool_use_id: 'other' }),
        use(agentFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeAgentResult(
        result({ ...agentFixture.toolResult, is_error: true }),
        use(agentFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeAgentResult(
        result({
          ...agentFixture.toolResult,
          content: [{ type: 'text', text: 'Known', citations: [] }],
        }),
        use(agentFixture.toolUse),
      ),
    ).toBeNull()
    expect(
      fromClaudeAgentResult(
        result({
          ...agentFixture.toolResult,
          content: Array.from({ length: 21 }, () => ({ type: 'text', text: 'Known' })),
        }),
        use(agentFixture.toolUse),
      ),
    ).toBeNull()
  })
})
