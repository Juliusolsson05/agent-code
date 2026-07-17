import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ToolUseBlock } from '@shared/types/transcript'

type Route = 'specialized' | 'generic'
type SemanticCase = { expectedRoute: Route; semanticBlock: SemanticLiveBlock }
type CommittedCase = { expectedRoute: Route; toolUse: ToolUseBlock }

function fixture<T>(name: string): { cases: T[] } {
  return JSON.parse(readFileSync(join(
    process.cwd(),
    'testing',
    'fixtures',
    'rendering-shapes',
    'codex',
    'exec',
    name,
  ), 'utf8')) as { cases: T[] }
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
