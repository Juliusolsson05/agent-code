import { describe, expect, it } from 'vitest'

import semanticPrefixFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/semantic-prefix.json'
import semanticFinalFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/semantic-final.json'
import committedFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/committed.json'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import { buildFingerprintIndex, classifySighting } from '@renderer/rendering/evidence/catalogCoverage'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

type Route = 'specialized' | 'generic'
type SemanticCase = { expectedRoute: Route; semanticBlock: SemanticLiveBlock }
type CommittedCase = {
  expectedRoute: Route
  expectedReceipt?: { rendererId: string; protocolId?: string }
  expectedResultDecision?: {
    action: 'absorb'
    ownerRenderId: string
    protocolId?: string
  }
  toolUse: ToolUseBlock
  toolResult?: ToolResultBlock
}

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
const catalogIndex = buildFingerprintIndex([CODEX_RENDER_SHAPES])

// WHY the specialized receipt is pinned to the Git protocol since the
// transport-normalization change: every captured specialized sample in these
// fixtures is a transparent `tools.exec_command({cmd:"git …"})` bridge, and a
// proven single-command bridge now deliberately shares native exec_command
// operation ownership — including the finite `command.git` route. Pinning the
// exact receipt (instead of accepting either renderer) keeps this suite an
// intentional record of the routing decision: if the Git route ever loses or
// gains these samples, that is a provider-boundary change that must be made
// here on purpose, not discovered in production. Generic-route coverage is
// unchanged: the non-command samples must still fall back.
const SPECIALIZED_RECEIPT = {
  rendererId: 'shared.command',
  protocolId: 'command.git',
}

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
        expect(decision.receipt).toEqual(SPECIALIZED_RECEIPT)
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
        expect(decision.receipt).toEqual(SPECIALIZED_RECEIPT)
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
        result: sample.toolResult ?? null,
        live: false,
        streaming: false,
      })
      expect(decision.toolUse.action).toBe(
        sample.expectedRoute === 'specialized' ? 'render' : 'fallback',
      )
      if (sample.expectedRoute === 'specialized' && decision.toolUse.action === 'render') {
        // WHY the receipt now belongs to the fixture case: one structural exec
        // fingerprint legitimately contains native Git bridges and embedded
        // Agent Code MCP operations. Collapsing both to a single expected
        // receipt would erase the content-gated route this evidence exists to
        // protect.
        expect(decision.toolUse.receipt).toEqual(sample.expectedReceipt ?? SPECIALIZED_RECEIPT)
      }
      if (sample.expectedResultDecision) {
        expect(decision.toolResult).toMatchObject(sample.expectedResultDecision)
      }
      if (sample.toolResult && decision.toolResult?.action === 'render') {
        const fingerprint = fingerprintRenderShape({
          provider: 'codex',
          plane: 'committed-tool-result',
          eventType: 'tool_result',
          payload: sample.toolResult,
        }).fingerprint
        expect(fingerprint).toBe('fp2-8571cc95')
        const definition = catalogIndex.byFingerprint.get(fingerprint)
        expect(definition).toBeDefined()
        expect(classifySighting({
          structuralFingerprint: fingerprint,
          lifecycle: 'durable',
          outcome: {
            kind: 'specialized',
            shapeId: definition!.id,
            rendererId: decision.toolResult.receipt.rendererId,
            protocolId: decision.toolResult.receipt.protocolId,
          },
        }, catalogIndex)).toEqual({ kind: 'known-claimed', shapeId: definition!.id })
      }
    }
  })
})
