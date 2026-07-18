import { describe, expect, it } from 'vitest'

import semanticPrefixFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/semantic-prefix.json'
import semanticFinalFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/semantic-final.json'
import committedFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/committed.json'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolUseBlock } from '@shared/types/transcript'

type Route = 'specialized' | 'generic'
type SemanticCase = { expectedRoute: Route; semanticBlock: SemanticLiveBlock }
type CommittedCase = { expectedRoute: Route; toolUse: ToolUseBlock }

const fixtures = {
  'semantic-prefix.json': semanticPrefixFixture,
  'semantic-final.json': semanticFinalFixture,
  'committed.json': committedFixture,
} as const

function fixture<T>(name: keyof typeof fixtures): { cases: T[] } {
  // WHY the fixtures are static imports: this is a renderer-project test and
  // therefore runs in a browser-like environment. The former node:fs loader
  // made Vitest fail before collecting the receipt assertions, so the test
  // never guarded the catalog it claimed to pin.
  return fixtures[name] as unknown as { cases: T[] }
}

const context = { committedToolResults: new Map() }

describe('Codex unified-exec evidence', () => {
  it('pins the captured prefix structure and proves both finite routes', () => {
    for (const sample of fixture<SemanticCase>('semantic-prefix.json').cases) {
      expect(fingerprintRenderShape({
        provider: 'codex',
        plane: 'semantic-tool',
        eventType: 'custom_tool_call',
        payload: sample.semanticBlock,
      }).fingerprint).toBe('fp2-679797aa')

      const decision = renderCodexSemanticBlock(sample.semanticBlock, context)
      expect(decision?.action).toBe(sample.expectedRoute === 'specialized' ? 'render' : 'fallback')
      if (sample.expectedRoute === 'specialized' && decision?.action === 'render') {
        expect(decision.receipt).toEqual({ rendererId: 'codex.rows.dispatch' })
      }
    }
  })

  it('pins the captured final structure and proves both finite routes', () => {
    for (const sample of fixture<SemanticCase>('semantic-final.json').cases) {
      expect(fingerprintRenderShape({
        provider: 'codex',
        plane: 'semantic-tool',
        eventType: 'custom_tool_call',
        payload: sample.semanticBlock,
      }).fingerprint).toBe('fp2-9b9a69b3')

      const decision = renderCodexSemanticBlock(sample.semanticBlock, context)
      expect(decision?.action).toBe(sample.expectedRoute === 'specialized' ? 'render' : 'fallback')
      if (sample.expectedRoute === 'specialized' && decision?.action === 'render') {
        expect(decision.receipt).toEqual({ rendererId: 'codex.rows.dispatch' })
      }
    }
  })

  it('pins the captured durable structure and proves both finite routes', () => {
    for (const sample of fixture<CommittedCase>('committed.json').cases) {
      expect(fingerprintRenderShape({
        provider: 'codex',
        plane: 'committed-tool-use',
        eventType: 'tool_use',
        payload: sample.toolUse,
      }).fingerprint).toBe('fp2-bb2ab36f')

      const decision = renderCodexOperation({
        toolUse: sample.toolUse,
        result: null,
        live: false,
        streaming: false,
      })
      expect(decision.toolUse.action).toBe(
        sample.expectedRoute === 'specialized' ? 'render' : 'fallback',
      )
      if (sample.expectedRoute === 'specialized' && decision.toolUse.action === 'render') {
        expect(decision.toolUse.receipt).toEqual({ rendererId: 'codex.rows.dispatch' })
      }
    }
  })
})
