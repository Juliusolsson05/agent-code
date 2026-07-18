import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { renderClaudeSemanticBlock } from '@providers/claude/renderer/semantic/dispatch'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { CLAUDE_RENDER_SHAPES } from '@providers/claude/renderer/shapes'
import {
  buildFingerprintIndex,
  classifySighting,
} from '@renderer/rendering/evidence/catalogCoverage'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolResultBlock } from '@shared/types/transcript'
import orchestrationFixture from '../../../../../testing/fixtures/rendering-shapes/claude/agent-code-orchestration/final.json'
import webFetchFixture from '../../../../../testing/fixtures/rendering-shapes/claude/web-fetch/semantic-final.json'
import webSearchFixture from '../../../../../testing/fixtures/rendering-shapes/claude/web-search/semantic-final.json'

const context = {
  committedToolResults: new Map<string, ToolResultBlock>(),
}

function block(overrides: Partial<SemanticLiveBlock>): SemanticLiveBlock {
  return {
    blockIndex: 0,
    kind: 'tool_use',
    finalized: true,
    ...overrides,
  }
}

// WHY this is a renderer test (and the filename carries `.renderer`): the
// suite renders provider React decisions as well as testing adapter routing.
// A plain `.test.tsx` matched none of the repository's Vitest projects, so the
// previous green suite never executed these production-semantic assertions.
describe('Claude semantic provider boundary', () => {
  it('keeps curated semantic fixtures on their cataloged canonical structures', () => {
    const cases = [
      ['claude.semantic.mcp-orchestration-close-run.v1', orchestrationFixture.semanticBlock],
      ['claude.semantic.webfetch.v1', webFetchFixture.semanticBlock],
      ['claude.semantic.websearch.v1', webSearchFixture.semanticBlock],
    ] as const
    for (const [shapeId, semanticBlock] of cases) {
      const fingerprint = fingerprintRenderShape({
        provider: 'claude',
        plane: 'semantic-tool',
        eventType: semanticBlock.kind,
        payload: semanticBlock,
      }).fingerprint
      expect(CLAUDE_RENDER_SHAPES[shapeId].fingerprints, shapeId).toContain(fingerprint)
    }
  })

  it('pins the orchestration fixture committed carrier to its catalog fingerprint', () => {
    // WHY the semantic and committed carriers need independent assertions:
    // one fixture file contains both, and an any-observation coverage check
    // lets a valid semantic block mask a stale committed tool_use skeleton.
    // `caller.type` is part of Claude's canonical committed fingerprint.
    const shapeId = 'claude.tool-use.mcp-orchestration-close-run.v1'
    const fingerprint = fingerprintRenderShape({
      provider: 'claude',
      plane: 'committed-tool-use',
      eventType: orchestrationFixture.toolUse.type,
      payload: orchestrationFixture.toolUse,
    }).fingerprint
    expect(CLAUDE_RENDER_SHAPES[shapeId].fingerprints).toContain(fingerprint)
  })

  it('declares generic adapter declines on the finite shapes and lifecycles that can take them', () => {
    const isGeneric = (disposition: { kind: string; rendererId?: string }): boolean =>
      disposition.kind === 'generic' && disposition.rendererId === 'shared.generic-tool'

    const globalGenericIds = Object.values(CLAUDE_RENDER_SHAPES)
      .filter(definition => definition.alternateDispositions?.some(isGeneric))
      .map(definition => definition.id)
      .sort()
    const inputCompleteGenericIds = Object.values(CLAUDE_RENDER_SHAPES)
      .filter(definition => definition.alternateDispositionsByLifecycle?.['input-complete']?.some(isGeneric))
      .map(definition => definition.id)
      .sort()

    // WHY this is an explicit inventory instead of “every specialized Claude
    // row gets generic”: an alternate is permission for the classifier to
    // accept that route. Broad policy tests turn future accidental fallthrough
    // into a green audit. Global entries below have only one lifecycle (or are
    // durable committed blocks); semantic entries with a prefix milestone put
    // the content decline specifically on input-complete because prefix already
    // has its own primary generic disposition.
    expect(globalGenericIds).toEqual([
      'claude.semantic.askuserquestion.v1',
      'claude.semantic.mcp-orchestration-read-agent.v1',
      'claude.semantic.read.v1',
      'claude.semantic.skill.v1',
      'claude.tool-use.agent.v1',
      'claude.tool-use.askuserquestion.v1',
      'claude.tool-use.bash.v1',
      'claude.tool-use.edit.v1',
      'claude.tool-use.mcp-orchestration-close-agent.v1',
      'claude.tool-use.mcp-orchestration-close-run.v1',
      'claude.tool-use.mcp-orchestration-create-agent.v1',
      'claude.tool-use.mcp-orchestration-list-agents.v1',
      'claude.tool-use.mcp-orchestration-read-agent.v1',
      'claude.tool-use.mcp-orchestration-send-prompt.v1',
      'claude.tool-use.mcp-orchestration-wait-agents.v1',
      'claude.tool-use.read.v1',
      'claude.tool-use.schedulewakeup.v1',
      'claude.tool-use.skill.v1',
      'claude.tool-use.taskcreate.v1',
      'claude.tool-use.taskupdate.v1',
      'claude.tool-use.toolsearch.v1',
      'claude.tool-use.webfetch.v1',
      'claude.tool-use.websearch.v1',
      'claude.tool-use.write.v1',
    ])
    expect(inputCompleteGenericIds).toEqual([
      'claude.semantic.agent.v1',
      'claude.semantic.edit.v1',
      'claude.semantic.mcp-orchestration-close-agent.v1',
      'claude.semantic.mcp-orchestration-close-run.v1',
      'claude.semantic.mcp-orchestration-create-agent.v1',
      'claude.semantic.mcp-orchestration-list-agents.v1',
      'claude.semantic.mcp-orchestration-send-prompt.v1',
      'claude.semantic.mcp-orchestration-wait-agents.v1',
      'claude.semantic.taskcreate.v1',
      'claude.semantic.taskupdate.v1',
      'claude.semantic.toolsearch.v1',
      'claude.semantic.webfetch.v1',
      'claude.semantic.websearch.v1',
      'claude.semantic.write.v1',
    ])
  })

  it('classifies real content declines without permitting semantic Bash to escape its provider row', () => {
    const index = buildFingerprintIndex([CLAUDE_RENDER_SHAPES])
    const generic = (shapeId: keyof typeof CLAUDE_RENDER_SHAPES, lifecycle: 'prefix' | 'input-complete' | 'durable') =>
      classifySighting({
        structuralFingerprint: CLAUDE_RENDER_SHAPES[shapeId].fingerprints[0],
        lifecycle,
        outcome: { kind: 'generic', shapeId, rendererId: 'shared.generic-tool' },
      }, index)

    // These values preserve the same structural fingerprints as their valid
    // twins: blank required strings, a drifted TaskUpdate status, and an
    // invalid ScheduleWakeup delay are content decisions made by adapters.
    // Both semantic input-complete and durable committed observations must
    // therefore classify as intentional rather than known-misrouted.
    for (const [shapeId, lifecycle] of [
      ['claude.semantic.agent.v1', 'input-complete'],
      ['claude.semantic.askuserquestion.v1', 'input-complete'],
      ['claude.semantic.skill.v1', 'input-complete'],
      ['claude.semantic.taskcreate.v1', 'input-complete'],
      ['claude.semantic.taskupdate.v1', 'input-complete'],
      ['claude.tool-use.bash.v1', 'durable'],
      ['claude.tool-use.schedulewakeup.v1', 'durable'],
    ] as const) {
      expect(generic(shapeId, lifecycle), `${shapeId} ${lifecycle}`).toEqual({
        kind: 'known-claimed',
        shapeId,
      })
    }

    // Prefix Agent is generic by its primary lifecycle disposition, not by a
    // global wildcard. This distinction ensures the complete-input alternate
    // can be removed independently if the strict adapter contract changes.
    expect(generic('claude.semantic.agent.v1', 'prefix')).toEqual({
      kind: 'known-claimed',
      shapeId: 'claude.semantic.agent.v1',
    })

    for (const lifecycle of ['prefix', 'input-complete'] as const) {
      expect(generic('claude.semantic.bash.v1', lifecycle)).toMatchObject({
        kind: 'known-misrouted',
        shapeId: 'claude.semantic.bash.v1',
      })
    }

    const bash = CLAUDE_RENDER_SHAPES['claude.semantic.bash.v1']
    for (const outcome of [
      { kind: 'specialized' as const, shapeId: bash.id, rendererId: 'claude.rows.dispatch' },
      {
        kind: 'specialized' as const,
        shapeId: bash.id,
        rendererId: 'shared.command',
        protocolId: 'command.git',
      },
    ]) {
      expect(classifySighting({
        structuralFingerprint: bash.fingerprints[0],
        lifecycle: 'input-complete',
        outcome,
      }, index)).toEqual({ kind: 'known-claimed', shapeId: bash.id })
    }
  })

  it('owns complete Bash/Edit/Write inputs through provider components', () => {
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Bash',
      toolUseId: 'bash',
      parsedInput: { command: 'printf ok' },
      inputJson: '{"command":"printf ok"}',
      inputJsonValid: true,
    }), context)).not.toBeUndefined()

    expect(renderClaudeSemanticBlock(block({
      toolName: 'Edit',
      toolUseId: 'edit',
      parsedInput: { file_path: '/workspace/a.ts', old_string: 'a', new_string: 'b' },
      inputJsonValid: true,
    }), context)).not.toBeUndefined()

    expect(renderClaudeSemanticBlock(block({
      toolName: 'Write',
      toolUseId: 'write',
      parsedInput: { file_path: '/workspace/a.ts', content: 'export {}' },
      inputJsonValid: true,
    }), context)).not.toBeUndefined()
  })

  it('keeps malformed semantic Bash provider-owned while committed whitespace Bash declines', () => {
    // WHY these structurally similar cases have different catalog routes:
    // semantic dispatch has a final ClaudeLiveBashRow safety net whose inner
    // JsonToolRow preserves malformed input under the Claude receipt. Durable
    // operation dispatch has no such wrapper and intentionally returns the
    // shared generic fallback when the command adapter rejects whitespace.
    // Treating “Bash” as one blanket generic-alternate policy would erase this
    // plane-specific ownership difference.
    for (const malformed of [
      block({
        toolName: 'Bash',
        parsedInput: { command: '   ' },
        inputJson: '{"command":"   "}',
        inputJsonValid: true,
      }),
      block({
        toolName: 'Bash',
        finalized: false,
        inputJson: '{"command":"',
      }),
    ]) {
      expect(renderClaudeSemanticBlock(malformed, context)).toMatchObject({
        action: 'render',
        receipt: { rendererId: 'claude.rows.dispatch' },
      })
    }

    expect(renderClaudeOperation({
      toolUse: {
        type: 'tool_use',
        id: 'blank-bash',
        name: 'Bash',
        input: { command: '   ' },
      },
      result: null,
      live: false,
      streaming: false,
    }).toolUse.action).toBe('fallback')
  })

  it('declines provider-neutral text and edit prefixes before identity closes', () => {
    // WHY these declines are asserted beside the positive routes: the catalog
    // deliberately keeps Edit/Write pre-identity prefixes on the declared
    // generic route. Claiming them early would manufacture a file operation.
    expect(renderClaudeSemanticBlock(block({
      kind: 'text',
      text: 'hello',
    }), context)).toBeUndefined()
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Edit',
      finalized: false,
      inputJson: '{"file_path":"',
    }), context)).toBeUndefined()
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Write',
      finalized: false,
      inputJson: '{"file_path":"',
    }), context)).toBeUndefined()
  })

  it('uses the production prefix adapter and preserves malformed MultiEdit evidence', () => {
    expect(renderClaudeSemanticBlock(block({
      toolName: 'Edit',
      finalized: false,
      inputJson: '{"file_path":"/workspace/a.ts","old_string":"a","new_string":"b',
    }), context)).toMatchObject({ action: 'render' })

    expect(() => renderClaudeSemanticBlock(block({
      toolName: 'MultiEdit',
      toolUseId: 'multi',
      parsedInput: { file_path: '/workspace/a.ts', edits: [null] },
      inputJsonValid: true,
    }), context)).not.toThrow()
    const decision = renderClaudeSemanticBlock(block({
      toolName: 'MultiEdit',
      toolUseId: 'multi',
      parsedInput: { file_path: '/workspace/a.ts', edits: [null] },
      inputJsonValid: true,
    }), context)
    expect(decision?.action).toBe('render')
    const html = decision?.action === 'render' ? renderToStaticMarkup(decision.node) : ''
    expect(html).toContain('unrecognized change 1 / 1')
    expect(html).toContain('View raw change input')
  })

  it('renders a large streaming Write from the adapter bounded preview', () => {
    const visiblePrefix = Array.from({ length: 5_000 }, (_, index) => `visible-${index}`).join('\n')
    const hiddenTail = 'MUST_NOT_REACH_STREAMING_DOM'
    const decision = renderClaudeSemanticBlock(block({
      toolName: 'Write',
      finalized: false,
      inputJson: JSON.stringify({
        file_path: '/workspace/large.ts',
        content: `${visiblePrefix}\n${hiddenTail}`,
      }),
    }), context)
    expect(decision?.action).toBe('render')
    const html = decision?.action === 'render' ? renderToStaticMarkup(decision.node) : ''
    expect(html).toContain('/workspace/large.ts')
    expect(html).toContain('streaming preview capped')
    expect(html).toContain('+≥')
    expect(html).not.toContain(hiddenTail)
  })

  it('labels finalized live Bash input as running until a result exists', () => {
    const decision = renderClaudeSemanticBlock(block({
      toolName: 'Bash',
      parsedInput: { command: 'printf ok' },
      inputJson: '{"command":"printf ok"}',
      // Force the provider's raw semantic fallback component; the ordinary
      // valid-input route already gets its running status from operation
      // dispatch, and this regression lived only in the fallback component.
      inputJsonValid: false,
      finalized: true,
    }), context)
    expect(decision?.action).toBe('render')
    const html = decision?.action === 'render' ? renderToStaticMarkup(decision.node) : ''
    expect(html).toContain('running')
    expect(html).not.toContain('streaming…')
  })

  it('records the owned workflow protocol symmetrically on use and result receipts', () => {
    const toolUse = {
      type: 'tool_use' as const,
      id: 'workflow',
      name: 'mcp__agent_code__workflow_run',
      input: { name: 'audit' },
    }
    const decision = renderClaudeOperation({
      toolUse,
      result: {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify({
          ok: true,
          run: { runId: 'run-1', status: 'running', workflow: { name: 'audit' } },
        }),
      },
      live: false,
      streaming: false,
    })
    expect(decision.toolUse).toMatchObject({
      action: 'render',
      receipt: { rendererId: 'claude.rows.dispatch', protocolId: 'agent-code.workflow' },
    })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'claude.rows.dispatch',
      protocolId: 'agent-code.workflow',
    })
  })

  it('never absorbs a familiar result behind a declined invocation', () => {
    const toolUse = {
      type: 'tool_use' as const,
      id: 'blank-edit',
      name: 'Edit',
      input: { file_path: ' ', old_string: 'a', new_string: 'b' },
    }
    const decision = renderClaudeOperation({
      toolUse,
      result: {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: 'The file /workspace/a.ts has been updated successfully.',
      },
      live: false,
      streaming: false,
    })

    expect(decision.toolUse.action).toBe('fallback')
    expect(decision.toolResult?.action).toBe('fallback')
  })
})
