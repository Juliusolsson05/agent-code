import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import committedFixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/committed.json'
import semanticFinalFixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/semantic-final.json'
import semanticPrefixFixture from '../../../../testing/fixtures/rendering-shapes/codex/wait/semantic-prefix.json'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
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
      const output = render(decision.toolResult.node)
      expect(output.container.textContent).toContain('Agent completed')
      expect(output.container.textContent).not.toContain('Script completed')
      expect(output.container.textContent).not.toContain('Wall time')
      output.unmount()
    }
  })
})
