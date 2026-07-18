import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import committedFixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/committed.json'
import semanticFinalFixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/semantic-final.json'
import semanticPrefixFixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/semantic-prefix.json'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import { buildFingerprintIndex, classifySighting } from '@renderer/rendering/evidence/catalogCoverage'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

type WaitCase = {
  expectedRoute: 'specialized' | 'generic'
  toolUse: ToolUseBlock
  toolResult?: ToolResultBlock
}

type SemanticWaitCase = {
  expectedRoute: 'specialized' | 'generic'
  semanticBlock: SemanticLiveBlock
}

const catalogIndex = buildFingerprintIndex([CODEX_RENDER_SHAPES])

describe('Codex wait evidence', () => {
  it('pins both captured semantic lifecycles and promotes only the closed input', () => {
    const samples: Array<{ fixture: SemanticWaitCase; fingerprint: string }> = [
      ...((semanticPrefixFixture.cases as SemanticWaitCase[]).map(fixture => ({
        fixture,
        fingerprint: 'fp2-d3325ec0',
      }))),
      ...((semanticFinalFixture.cases as SemanticWaitCase[]).map(fixture => ({
        fixture,
        fingerprint: 'fp2-cee28660',
      }))),
    ]
    for (const { fixture, fingerprint } of samples) {
      expect(fingerprintRenderShape({
        provider: 'codex',
        plane: 'semantic-tool',
        eventType: 'function_call',
        payload: fixture.semanticBlock,
      }).fingerprint).toBe(fingerprint)
      const decision = renderCodexSemanticBlock(fixture.semanticBlock, {
        committedToolResults: new Map(),
      })
      expect(decision?.action).toBe(
        fixture.expectedRoute === 'specialized' ? 'render' : 'fallback',
      )
      if (fixture.expectedRoute === 'specialized' && decision?.action === 'render') {
        expect(decision.receipt).toEqual({
          rendererId: 'codex.rows.dispatch',
          protocolId: 'command.continuation',
        })
        if (fixture.semanticBlock.finalized) {
          const output = render(decision.node)
          expect(output.container.textContent).toContain('request completed')
          expect(output.container.textContent).not.toContain(' waiting')
          output.unmount()
        }
      }
    }
  })

  it('pins the captured continuation route and its fail-closed alternate', () => {
    for (const sample of committedFixture.cases as WaitCase[]) {
      expect(fingerprintRenderShape({
        provider: 'codex',
        plane: 'committed-tool-use',
        eventType: 'tool_use',
        payload: sample.toolUse,
      }).fingerprint).toBe('fp2-32f6d3bc')

      const decision = renderCodexOperation({
        toolUse: sample.toolUse,
        result: sample.toolResult ?? null,
        live: false,
        streaming: false,
      })
      expect(decision.toolUse.action).toBe(
        sample.expectedRoute === 'specialized' ? 'render' : 'fallback',
      )
      if (sample.expectedRoute !== 'specialized' || decision.toolUse.action !== 'render') continue
      expect(decision.toolUse.receipt).toEqual({
        rendererId: 'codex.rows.dispatch',
        protocolId: 'command.continuation',
      })

      // WHY assert the painted output from the captured pair: continuation
      // identity and transport stripping are one user-facing contract. A route
      // test alone would stay green if the old Script/Wall time chrome returned.
      if (decision.toolResult?.action !== 'render') throw new Error('expected correlated result')
      const resultFingerprint = fingerprintRenderShape({
        provider: 'codex',
        plane: 'committed-tool-result',
        eventType: 'tool_result',
        payload: sample.toolResult!,
      }).fingerprint
      expect(resultFingerprint).toBe('fp2-8571cc95')
      const resultDefinition = catalogIndex.byFingerprint.get(resultFingerprint)
      expect(resultDefinition).toBeDefined()
      expect(classifySighting({
        structuralFingerprint: resultFingerprint,
        lifecycle: 'durable',
        outcome: {
          kind: 'specialized',
          shapeId: resultDefinition!.id,
          rendererId: decision.toolResult.receipt.rendererId,
          protocolId: decision.toolResult.receipt.protocolId,
        },
      }, catalogIndex)).toEqual({ kind: 'known-claimed', shapeId: resultDefinition!.id })
      const output = render(decision.toolResult.node)
      expect(output.container.textContent).toContain('Agent completed')
      expect(output.container.textContent).not.toContain('Script completed')
      expect(output.container.textContent).not.toContain('Wall time')
      output.unmount()
    }
  })

  it('renders termination explicitly and keeps yielded continuations nonterminal', () => {
    const decision = renderCodexOperation({
      toolUse: {
        type: 'tool_use', id: 'wait-running', name: 'wait',
        input: { cell_id: 'cell-7', terminate: true, yield_time_ms: 10_000 },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'wait-running',
        content: 'Script running with cell ID cell-7\nWall time 10 seconds\nOutput:\n\nstill working',
        is_error: false,
      },
      live: false,
      streaming: false,
    })
    if (decision.toolUse.action !== 'render') throw new Error('expected wait renderer')
    const output = render(decision.toolUse.node)
    expect(output.getByText('Terminate command')).toBeInTheDocument()
    expect(output.getByText('running')).toBeInTheDocument()
    expect(output.queryByText('completed')).not.toBeInTheDocument()
  })

  it('recognizes the upstream terminal envelope returned by terminate', () => {
    const decision = renderCodexOperation({
      toolUse: {
        type: 'tool_use', id: 'wait-terminated', name: 'wait',
        input: { cell_id: 'cell-7', terminate: true },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'wait-terminated',
        content: 'Script terminated\nWall time 0.1 seconds\nOutput:\n\n',
        is_error: false,
      },
      live: false,
      streaming: false,
    })
    if (decision.toolUse.action !== 'render') throw new Error('expected wait renderer')
    const output = render(decision.toolUse.node)
    expect(output.getByText('Terminate command')).toBeInTheDocument()
    expect(output.getByText('terminated')).toBeInTheDocument()
  })

  it('absorbs an empty successful wait result instead of painting a labeled blank box', () => {
    const decision = renderCodexOperation({
      toolUse: {
        type: 'tool_use', id: 'wait-empty', name: 'wait',
        input: { cell_id: 'cell-7', yield_time_ms: 10_000 },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'wait-empty',
        content: 'Script completed\nWall time 0.1 seconds\nOutput:\n\n',
        is_error: false,
      },
      live: false,
      streaming: false,
    })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      protocolId: 'command.continuation',
    })
  })

  it('keeps an empty error result visible because its failure state is evidence', () => {
    // WHY error results cannot share the empty-success absorption: an empty
    // payload does not erase `is_error`. Hiding this row would turn a proven
    // failed continuation into an apparently harmless acknowledgement.
    const decision = renderCodexOperation({
      toolUse: {
        type: 'tool_use', id: 'wait-error', name: 'wait',
        input: { cell_id: 'cell-7', yield_time_ms: 10_000 },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'wait-error',
        content: '',
        is_error: true,
      },
      live: false,
      streaming: false,
    })
    expect(decision.toolResult).toMatchObject({
      action: 'render',
      receipt: { protocolId: 'command.continuation' },
    })
  })
})
